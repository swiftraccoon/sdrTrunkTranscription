use dotenv::dotenv;
use notify::{
    recommended_watcher, EventKind, RecursiveMode, Result as NotifyResult, Watcher,
};
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::{
    multipart::{Form, Part},
    Client,
};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{runtime::Runtime, sync::mpsc};
use tokio::time::sleep;

/// Lazily initialized, shared `reqwest::Client` wrapped in an `Arc`.
/// Avoids `static mut` usage and the associated warnings.
static CLIENT: Lazy<Arc<Client>> = Lazy::new(|| {
    Arc::new(
        Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .expect("Failed to create HTTP client"),
    )
});

/// A small struct holding data that identifies a "processed" transcription file.
/// We'll use the `.txt` file's path stem, size, and last-modified time.
#[derive(Debug, Clone, Eq, PartialEq, Hash)]
struct ProcessedFile {
    stem: String,
    size: u64,
    modified: SystemTime,
}

/// A global queue (up to 25 entries) of recently processed files to avoid re-uploads.
/// We store `(stem, size, modified)` and skip if the exact same file shows up again.
static PROCESSED_FILES: Lazy<Mutex<VecDeque<ProcessedFile>>> = Lazy::new(|| {
    Mutex::new(VecDeque::new()) // Start empty
});

/// NEW: A global set to track files for which an upload is currently in progress.
/// This helps avoid a race condition where multiple events fire before we get a
/// chance to mark the file as processed.
static UPLOADS_IN_PROGRESS: Lazy<Mutex<HashSet<ProcessedFile>>> = Lazy::new(|| {
    Mutex::new(HashSet::new())
});

/// Lazily initialized, environment-based API URL.
/// Reads the `API_URL` environment variable (from .env if present).
static API_URL: Lazy<String> = Lazy::new(|| {
    env::var("API_URL").expect("API_URL environment variable not set")
});

/// Lazily initialized, environment-based API Key.
/// Reads the `API_KEY` environment variable (from .env if present).
static API_KEY: Lazy<String> = Lazy::new(|| {
    env::var("API_KEY").expect("API_KEY environment variable not set")
});

fn main() -> NotifyResult<()> {
    dotenv().ok();
    let monitored_directory = env::var("MONITORED_DIRECTORY")
        .expect("MONITORED_DIRECTORY environment variable not set");
    let root_path_buf = PathBuf::from(&monitored_directory);
    println!("Monitoring directory: {:?}", root_path_buf);

    let rt = Runtime::new().unwrap();
    rt.block_on(async {
        // 1) Set up the raw (std::sync::mpsc) channel for the notify watcher.
        let (raw_tx, raw_rx) = std::sync::mpsc::channel();
        let mut watcher = recommended_watcher(move |res| raw_tx.send(res).unwrap())?;
        watcher.watch(&root_path_buf, RecursiveMode::Recursive)?;

        // 2) Set up an async MPSC channel for “debouncing” file events.
        let (debounce_tx, mut debounce_rx) = mpsc::unbounded_channel::<PathBuf>();

        // 3) Spawn a background task that coalesces events and waits for files to stabilize.
        let debounce_task = tokio::spawn(async move {
            let mut last_update: HashMap<PathBuf, Instant> = HashMap::new();
            let mut in_flight: HashSet<PathBuf> = HashSet::new();

            while let Some(path) = debounce_rx.recv().await {
                let now = Instant::now();
                last_update.insert(path.clone(), now);

                // If we haven't already spawned a "wait and check" task for this path,
                // mark it as in-flight and spawn one.
                if !in_flight.contains(&path) {
                    in_flight.insert(path.clone());

                    let path_clone = path.clone();
                    let last_update_clone = last_update.clone();
                    let root_path_clone = root_path_buf.clone();

                    tokio::spawn(async move {
                        // Debounce interval
                        let debounce_delay = Duration::from_secs(3);

                        loop {
                            sleep(debounce_delay).await;
                            // Check if the file has changed since we started waiting.
                            if let Some(last) = last_update_clone.get(&path_clone).cloned() {
                                let elapsed = Instant::now().duration_since(last);
                                if elapsed >= debounce_delay {
                                    // The file has been stable for 3s => let's process it.
                                    break;
                                }
                            } else {
                                // If it's no longer in the map, it might have been removed or renamed.
                                return;
                            }
                        }

                        // Process (upload) only if it meets our "should_process_file" logic.
                        if should_process_file(&path_clone, &root_path_clone) {
                            process_and_upload(&path_clone).await;
                        }
                    });
                }
            }

            // Return a result for demonstration. We'll convert to notify::Error if needed.
            Ok::<(), std::io::Error>(())
        });

        // 4) Read events from the watcher synchronously. Forward relevant ones to the debounce channel.
        while let Ok(event_res) = raw_rx.recv() {
            match event_res {
                Ok(event) => {
                    // We only care about Create/Modify for potential new or updated files
                    if let EventKind::Create(_) | EventKind::Modify(_) = event.kind {
                        for path in event.paths {
                            let _ = debounce_tx.send(path);
                        }
                    }
                }
                Err(e) => eprintln!("Error handling event: {:?}", e),
            }
        }

        // 5) Handle the result of the debounce task explicitly.
        match debounce_task.await {
            Ok(Ok(())) => println!("Debounce task finished successfully."),
            Ok(Err(e)) => {
                // The async block inside `tokio::spawn` returned an error. Convert std::io::Error -> notify::Error if desired.
                return Err(notify::Error::from(e));
            }
            Err(join_error) => {
                eprintln!("Debounce task panicked or was cancelled: {}", join_error);
                return Ok(());
            }
        }

        Ok(())
    })?;

    Ok(())
}

/// Decides whether the file is of interest (non-empty file, not at the root dir, etc.).
fn should_process_file(file_path: &PathBuf, root_path: &PathBuf) -> bool {
    let should_process = file_path.parent() != Some(root_path) && file_path.is_file();
    println!("Should process {:?}: {}", file_path, should_process);
    should_process
}

/// Reads the .mp3 and .txt pair, checks if .txt has content, parses metadata, uploads via `CLIENT`,
/// but first checks if we've recently processed (or are currently uploading) an identical file.
async fn process_and_upload(path: &PathBuf) {
    println!("Stable file -> attempting to upload: {:?}", path);

    // Attempt to find matching .mp3 and .txt
    if let Some((mp3_path, txt_path)) = extract_file_info(path) {
        // Gather .txt metadata to see if it's non-empty and to build our "signature"
        let txt_metadata = match fs::metadata(&txt_path) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("Failed to get metadata for .txt: {}", e);
                return;
            }
        };
        let txt_size = txt_metadata.len();
        if txt_size == 0 {
            println!("Transcription file is empty, skipping upload.");
            return;
        }
        let txt_modified = txt_metadata.modified().unwrap_or(UNIX_EPOCH);

        // We'll use the file stem to identify a unique "base name".
        let stem = match txt_path.file_stem() {
            Some(s) => s.to_string_lossy().to_string(),
            None => {
                eprintln!("Could not get file stem for {:?}", txt_path);
                return;
            }
        };

        // Build a struct that identifies this .txt exactly
        let signature = ProcessedFile {
            stem: stem.clone(),
            size: txt_size,
            modified: txt_modified,
        };

        // Check if we've already uploaded this exact file in the past
        if has_already_been_processed(&signature) {
            println!("Already uploaded this exact transcription, skipping: {}", signature.stem);
            return;
        }

        // NEW: Prevent simultaneous uploads of the same file by checking UPLOADS_IN_PROGRESS
        // If it is "in progress," skip.
        {
            let mut in_progress = UPLOADS_IN_PROGRESS.lock().unwrap();
            if in_progress.contains(&signature) {
                println!(
                    "Upload is already in progress for '{}', skipping duplicate in-flight upload.",
                    signature.stem
                );
                return;
            }
            // If not in progress, mark it so that any other near-simultaneous event will skip
            in_progress.insert(signature.clone());
        }

        // 1) Read the .txt
        let txt_bytes = match fs::read(&txt_path) {
            Ok(bytes) => bytes,
            Err(e) => {
                eprintln!("Failed reading .txt file: {}", e);
                // IMPORTANT: If reading the file fails, we remove the "in progress" entry
                clear_in_progress(&signature);
                return;
            }
        };

        // 2) Parse the MP3
        let filename = match mp3_path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s,
            None => {
                println!("Invalid mp3 filename, skipping upload.");
                clear_in_progress(&signature);
                return;
            }
        };

        if let Some((timestamp, talkgroup_id, radio_id)) = parse_filename(filename) {
            let mp3_bytes = match fs::read(&mp3_path) {
                Ok(bytes) => bytes,
                Err(e) => {
                    eprintln!("Failed reading .mp3 file: {}", e);
                    clear_in_progress(&signature);
                    return;
                }
            };

            println!(
                "Uploading -> timestamp: {}, talkgroup: {}, radio: {}",
                timestamp, talkgroup_id, radio_id
            );

            let mp3_part = Part::bytes(mp3_bytes)
                .file_name(filename.to_string())
                .mime_str("audio/mpeg")
                .expect("Invalid MIME type");
            let txt_filename = txt_path.file_name().unwrap().to_str().unwrap();
            let txt_part = Part::bytes(txt_bytes)
                .file_name(txt_filename.to_string())
                .mime_str("text/plain")
                .expect("Invalid MIME type");

            let form = Form::new()
                .text("talkgroupId", talkgroup_id)
                .text("timestamp", timestamp)
                .text("radioId", radio_id)
                .part("mp3", mp3_part)
                .part("transcription", txt_part);

            // Perform the upload
            match CLIENT
                .post(API_URL.as_str())
                .header("X-API-Key", API_KEY.as_str())
                .multipart(form)
                .send()
                .await
            {
                Ok(res) => {
                    println!("Upload response: {:?}", res);

                    // If status is success (2xx) or 409 Conflict, we will mark it as processed
                    // so we never attempt to upload this exact file again.
                    if res.status().is_success() || res.status() == reqwest::StatusCode::CONFLICT {
                        println!("Marking file as processed to prevent duplicate uploads.");
                        mark_as_processed(signature.clone());
                    } else {
                        eprintln!("Unexpected server status: {}", res.status());
                    }
                }
                Err(e) => {
                    eprintln!("Upload failed: {}", e);
                }
            }

            // Finally, whether success or failure, we remove from "in progress" so future tries can re-attempt if needed.
            clear_in_progress(&signature);
        } else {
            // If the filename doesn't parse, remove from "in progress"
            clear_in_progress(&signature);
        }
    }
}

/// Checks if a file with this signature (stem, size, modified) has already been processed.
fn has_already_been_processed(signature: &ProcessedFile) -> bool {
    let processed_files = PROCESSED_FILES.lock().unwrap();
    processed_files.contains(signature)
}

/// Marks a file as processed by adding it to the ring buffer, which keeps up to 25 entries.
fn mark_as_processed(signature: ProcessedFile) {
    let mut processed_files = PROCESSED_FILES.lock().unwrap();
    processed_files.push_back(signature);
    while processed_files.len() > 25 {
        processed_files.pop_front();
    }
}

/// Removes the signature from the set of in-progress uploads, ensuring
/// that we can re-attempt if the original upload fails for unexpected reasons.
fn clear_in_progress(signature: &ProcessedFile) {
    let mut in_progress = UPLOADS_IN_PROGRESS.lock().unwrap();
    in_progress.remove(signature);
}

/// Given a file path like `.../20241223_204051North_Carolina_VIPER_Cleveland_T-BennsKControl__TO_P52189_[52193]_FROM_2151975.mp3`,
/// we pair it with `.../20241223_204051North_Carolina_VIPER_Cleveland_T-BennsKControl__TO_P52189_[52193]_FROM_2151975.txt`
/// if both exist.
fn extract_file_info(file_path: &PathBuf) -> Option<(PathBuf, PathBuf)> {
    let file_stem = file_path.file_stem()?.to_str()?;
    let parent_dir = file_path.parent()?;
    let mp3_path = parent_dir.join(format!("{}.mp3", file_stem));
    let txt_path = parent_dir.join(format!("{}.txt", file_stem));

    if mp3_path.exists() && txt_path.exists() {
        Some((mp3_path, txt_path))
    } else {
        None
    }
}

/// Updated regex to capture:
/// - Group 1: `(\d{8}_\d{6})` = the timestamp
/// - Group 2: `([A-Za-z]?\d+)` = optional letter + digits (e.g. `P52198`)
///            and we strip out letters in code.
/// - Optional bracket `(\[[^\]]*\])?` e.g. `[52193]` we ignore
/// - Group 3: `_FROM_(\d+)` = the radio ID (optional)
///
/// Then we remove any leading letters from the talkgroup ID after capture.
fn parse_filename(filename: &str) -> Option<(String, String, String)> {
    // This pattern allows e.g.:
    //  20241223_204146...__TO_P52198_FROM_2499936.mp3  -> talkgroup "P52198" -> final "52198"
    //  20241223_204051...__TO_P52189_[52193]_FROM_2151975.mp3
    // And if `_FROM_` is missing, radio_id defaults to "123456"
    let re = Regex::new(
        r"(\d{8}_\d{6}).*__TO_([A-Za-z]?\d+)(?:\[[^\]]*\])?(?:_FROM_(\d+))?"
    ).unwrap();

    re.captures(filename).and_then(|cap| {
        // Group 1: timestamp
        let timestamp = cap.get(1)?.as_str().to_string();

        // Group 2: the talkgroup ID, possibly with a letter prefix.
        // e.g. "P52189" => remove leading letters => "52189"
        let raw_tg = cap.get(2)?.as_str();
        let talkgroup_id = raw_tg.trim_start_matches(|c: char| c.is_ascii_alphabetic()).to_string();

        // Group 3: optional radio ID, else default to "123456"
        let radio_id = cap
            .get(3)
            .map_or("123456".to_string(), |m| m.as_str().to_string());

        Some((timestamp, talkgroup_id, radio_id))
    })
}
