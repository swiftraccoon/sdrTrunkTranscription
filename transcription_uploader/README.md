# Transcription Uploader

A Rust application that **monitors a directory** for new or modified `.mp3` files (alongside corresponding `.txt` transcriptions) and **uploads** them to a remote API endpoint. The app uses **file event watching**, **debouncing**, and **signature-based deduplication** to avoid re-uploading identical transcriptions. 

> **Table of Contents**
> 1. [Features](#features)  
> 2. [Project Structure](#project-structure)  
> 3. [Prerequisites](#prerequisites)  
> 4. [Installation](#installation)  
> 5. [Configuration](#configuration)  
> 6. [Usage](#usage)  
> 7. [Modifications](#modifications)  
> 8. [Running as a systemd Service](#running-as-a-systemd-service)  

---

## Features
- **File System Monitoring**: Watches the specified directory (recursively) for new or changed `.mp3` and `.txt` pairs.  
- **Debouncing**: Waits until files have been stable (unchanged) for a short period before uploading.  
- **Safe Re-Uploads**: Maintains a queue of recently processed files to avoid duplicates.  
- **Filename Parsing**: Extracts metadata (timestamp, talkgroup ID, and radio ID) from the `.mp3` filename using a Regex pattern.  
- **API Integration**: Sends `.mp3` and `.txt` data, along with metadata, to a provided API endpoint with a specified API key.  

---

## Project Structure

```
transcription_uploader
├── Cargo.toml
└── src
    └── main.rs
```

### High-Level Flow
1. **Watch Directory**: The app uses the [`notify`](https://crates.io/crates/notify) crate to watch a directory (specified by `MONITORED_DIRECTORY`).  
2. **Debounce Changes**: When a file creation/modification event occurs, it’s added to an internal queue. A short wait ensures the file is fully written before uploading.  
3. **Upload**: The app checks for corresponding `.mp3` and `.txt` files, parses relevant metadata from the filename, then uploads the pair to the API.  
4. **Prevent Duplicate Uploads**: The app keeps the last 25 processed `.txt` files (based on size, modification time, and name) in memory to avoid re-uploads of identical data.

---

## Prerequisites
- **Rust** (1.64+ recommended) and Cargo installed.  
- Ability to create or modify environment variables / `.env` files.  
- An API endpoint that accepts multipart form data (matching what this app sends).  

---

## Installation

1. **Clone the repository** (example command):
   ```bash
   git clone https://github.com/swiftraccoon/sdrTrunkTranscription.git
   cd sdrTrunkTranscription/transcription_uploader
   ```

2. **Build the project**:
   ```bash
   cargo build --release
   ```
   This will produce a binary in `target/release/transcription_uploader` (the name will depend on your Cargo.toml `[[bin]]` configuration).

---

## Configuration

The application reads **three required** environment variables (plus any others you might add). You can provide them in a `.env` file (using the [`dotenv`](https://crates.io/crates/dotenv) format) at the project root, or set them in your system environment:

| Variable                | Description                                                                     |
|-------------------------|---------------------------------------------------------------------------------|
| `MONITORED_DIRECTORY`   | Path to the directory that will be monitored for new/modified files.           |
| `API_URL`               | The URL to which `.mp3` and `.txt` files (with metadata) will be uploaded.     |
| `API_KEY`               | The API key used for authentication (`X-API-Key` header) with the upload server.|

### .env Example

```bash
MONITORED_DIRECTORY="/path/to/recordings"
API_URL="https://my.api.endpoint.com/api/upload"
API_KEY="mysecretapikey"
```

> **Note**: The `.env` file is **not required** if you set the environment variables in another way.

---

## Usage

1. **Set environment variables**. If you’re using a `.env` file, ensure it’s in the same directory where you run the binary or in the project root.

2. **Run the application** (from the project root):
   ```bash
   cargo run --release
   ```
   Or run the compiled binary directly:
   ```bash
   ./target/release/transcription_uploader
   ```

3. **Monitor Output**:  
   - The app prints messages indicating which directory is being watched.  
   - On file create or modify events, the app logs whether it will process the file and, if so, attempts an upload.  
   - If the upload is successful, you’ll see `Upload successful: ...`; otherwise, it logs the error.

---

## Modifications

This application is designed with **extensibility** in mind. Below are some ways you might modify it:

1. **Change the Debounce Interval**  
   - By default, the debounce interval is `3` seconds. Look for `let debounce_delay = Duration::from_secs(3);` inside the background debounce task. Adjust this to suit your environment if files need longer to fully write.  

2. **Custom Filename Parsing**  
   - The logic that extracts `timestamp`, `talkgroup_id`, and `radio_id` from the filename is in `parse_filename()`. It uses a `Regex` to match a specific pattern:
     ```rust
     let re = Regex::new(
       r"(\d{8}_\d{6}).*__TO_([A-Za-z]?\d+)(?:\[[^\]]*\])?(?:_FROM_(\d+))?"
     ).unwrap();
     ```
     If your filenames differ in format, **update the regex** to capture the new pattern and adjust how you parse the capture groups.

3. **Modify or Add Metadata**  
   - You can include additional metadata in the multipart form by adding more `.text("key", "value")` or `.part(...)` calls in the `process_and_upload()` function.

4. **Altering the Deduplication Logic**  
   - The app currently keeps a queue of 25 recently processed files, checking `(stem, size, modified)` to skip identical repeats. You can change the capacity or the fields used for deduplication inside `mark_as_processed()` or `has_already_been_processed()`.

5. **Different HTTP Client Configuration**  
   - The `reqwest::Client` is built once, globally, accepting invalid certs for demo/troubleshooting environments. For stricter security, remove `danger_accept_invalid_certs(true)` or configure TLS properly.

---

## Running as a systemd Service

To have the application run automatically on system startup (especially on Linux servers), you can set it up as a **systemd** service. Below is a generic example:

1. **Create a Service File**  
   Create a file named `transcription_uploader.service` (or any name you prefer) in `/etc/systemd/system/`:

   ```ini
   [Unit]
   Description=Transcription Uploader Service
   After=network.target

   [Service]
   Type=simple
   ExecStart=/usr/local/bin/transcription_uploader
   # If you rely on a .env file, specify an EnvironmentFile (adjust the path):
   EnvironmentFile=/etc/transcription_uploader.env
   # Alternatively, define environment variables directly:
   # Environment="MONITORED_DIRECTORY=/path/to/recordings"
   # Environment="API_URL=https://my.api.endpoint.com/api/upload"
   # Environment="API_KEY=mysecretapikey"

   # Restart on failure
   Restart=on-failure
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

2. **Place the Binary**  
   - Copy your compiled binary (`target/release/transcription_uploader`) to `/usr/local/bin/` (or any other location referenced by `ExecStart`):
     ```bash
     sudo cp target/release/transcription_uploader /usr/local/bin/
     ```

3. **Create Environment File** (if needed)  
   - If you want to keep environment variables in a file, create `/etc/transcription_uploader.env`:
     ```bash
     MONITORED_DIRECTORY="/path/to/recordings"
     API_URL="https://my.api.endpoint.com/api/upload"
     API_KEY="mysecretapikey"
     ```
   - Make sure the file is readable by systemd (e.g., `chmod 644 /etc/transcription_uploader.env`).

4. **Enable & Start the Service**  
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable transcription_uploader.service
   sudo systemctl start transcription_uploader.service
   ```

5. **Check Status & Logs**  
   ```bash
   sudo systemctl status transcription_uploader.service
   journalctl -u transcription_uploader.service -f
   ```

> **Note**: If you prefer running it under a specific user, add `User=username` under the `[Service]` section, and ensure the user has the necessary permissions to read the environment file and watch the specified directory.

---

### Thank you for using Transcription Uploader!

We hope this tool simplifies your workflow by automating the upload of `.mp3` recordings and associated transcription files. If you have any questions or improvements, feel free to open an issue or submit a pull request in the repository.