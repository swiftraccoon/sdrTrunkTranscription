# SDRTrunk Transcriber

`transcriber.py` automatically monitors a directory for newly created `.mp3` files, checks their durations, and transcribes them using [Faster Whisper](https://github.com/guillaumekln/faster-whisper). Files below a certain duration threshold are moved to a designated "too short or error" folder, while longer files are transcribed and neatly stored alongside their text transcripts.

---

## Table of Contents
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration & Customization](#configuration--customization)
  - [Directory Paths](#directory-paths)
  - [Model & Transcription Settings](#model--transcription-settings)
  - [Transcription Concurrency](#transcription-concurrency)
  - [Duration Threshold](#duration-threshold)
  - [Re-encoding with FFmpeg](#re-encoding-with-ffmpeg)
  - [Other Script Behaviors](#other-script-behaviors)
- [Running on Different Hardware](#running-on-different-hardware)
- [Running as a systemd Service](#running-as-a-systemd-service)
  - [Example Service File](#example-service-file)
  - [Enabling and Starting the Service](#enabling-and-starting-the-service)
  - [Managing the Service](#managing-the-service)
- [Troubleshooting](#troubleshooting)

---

## Features

1. **Automatic Monitoring**  
   Uses [Watchdog](https://pypi.org/project/watchdog/) to watch a specified directory for new `.mp3` files.

2. **File Stability Check**  
   Waits for the file size to remain stable for a few seconds before processing, ensuring the file is completely written.

3. **Duration-Based Filtering**  
   Files below a certain threshold duration are moved to a “too short” folder, bypassing transcription attempts.

4. **Transcription with Faster Whisper**  
   Automatically transcribes audio files using GPU acceleration (NVIDIA CUDA) by default. Text files are saved in the same directory as the processed `.mp3`.

5. **Error Handling & Re-encoding**  
   If a file is unreadable or fails initial checks, the script attempts to fix it via re-encoding (using `ffmpeg`) and retries transcription.

6. **Organized Output**  
   Each transcribed file and its corresponding `.txt` output are moved into a subdirectory named after a “talkgroup ID” extracted from the filename.

7. **Configurable Parameters**  
   All key settings (model size, concurrency limits, thresholds, etc.) can be modified in the `Config` class for different hardware or use cases.

---

## Requirements

1. **Python 3.8+** recommended.
2. **Pip packages**:
   - `faster-whisper` (GPU-enabled Whisper model)
   - `watchdog` (file-system event monitoring)
   - `mutagen` (reading MP3 metadata)
   - `ffmpeg` (command-line tool required by `faster-whisper` for re-encoding)
3. **CUDA Toolkit** (if using GPU acceleration — otherwise, you can configure CPU-only usage)
4. **Operating System**:  
   - This script should run on Linux, macOS, and Windows as long as Python and the above dependencies are available. However, GPU (CUDA) support typically implies Linux or Windows with NVIDIA drivers installed.

---

## Installation

1. **Clone the repository** (or download the script):

   ```bash
   git clone https://github.com/swiftraccoon/sdrTrunkTranscription.git
   cd sdrTrunkTranscription/transcriber
   ```

2. **Install dependencies**:

   ```bash
   pip install faster-whisper watchdog mutagen
   ```
   
   > **Note:** If you do not have `ffmpeg`, install it via your system’s package manager:
   > - **Linux (Debian/Ubuntu):** `sudo apt-get install ffmpeg`
   > - **Linux (Fedora/RedHat):** `sudo dnf install ffmpeg`
   > - **macOS:** `brew install ffmpeg`
   > - **Windows:** [Download from FFmpeg official page](https://ffmpeg.org/download.html)

3. **(Optional, but strongly recommended) Create a virtual environment** to isolate dependencies:

   ```bash
   python -m venv venv
   source venv/bin/activate    # On Linux/macOS
   # OR
   venv\Scripts\activate.bat  # On Windows
   ```

---

## Usage

1. **Edit the script for your environment**:  
   Open `transcriber/transcriber.py` and check the following constants near the top:
   ```python
   ROOT_DIRECTORY = "/home/USER/SDRTrunk/recordings"
   TOO_SHORT_DIRECTORY = "/home/USER/SDRTrunk/tooShortOrError"
   ```
   Make sure these point to the directories you want to monitor and store “too short or error” files.

2. **Run the script**:
   ```bash
   python transcriber.py
   ```
   The script will:
   - Start watching `ROOT_DIRECTORY` for new `.mp3` files.
   - Process any existing `.mp3` files (if configured).
   - Continue to run until you press **Ctrl+C** (SIGINT).

3. **Check the logs**:
   - By default, logs are saved to `sdrtrunk_transcription.log`, which will rotate every 14 days, keeping the last 5 backups.
   - You can view in real-time on Linux/macOS with:
     ```bash
     tail -f sdrtrunk_transcription.log
     ```

---

## Configuration & Customization

All key parameters are defined within the `Config` class in `transcriber/transcriber.py`. Below are the most common adjustments you might make.

### Directory Paths

```python
ROOT_DIRECTORY = "/home/USER/SDRTrunk/recordings"
TOO_SHORT_DIRECTORY = "/home/USER/SDRTrunk/tooShortOrError"
```
- **`ROOT_DIRECTORY`**: The main directory that Watchdog monitors for new `.mp3` files.
- **`TOO_SHORT_DIRECTORY`**: Where short or problematic `.mp3` files are placed.

### Model & Transcription Settings

Inside the `Config` class:
```python
MODEL_SIZE = "large-v3"  # or "small", "medium", etc.
LANGUAGE = "en"
BEAM_SIZE = 8
PATIENCE = 8
BEST_OF = 6
...
```
- **`MODEL_SIZE`**: The size of the Faster Whisper model to use. Possible options include `tiny`, `base`, `small`, `medium`, `large-v2`, `large-v3`, etc.  
  - Larger models are more accurate but require more GPU memory and processing time.
  - Smaller models are faster and use less memory but may be less accurate.
- **`LANGUAGE`**: Force an initial language (e.g., `"en"` for English). Leave blank or `None` for auto-detection.
- **Beam Search Settings** (`BEAM_SIZE`, `PATIENCE`, `BEST_OF`): Tweak these for better or faster results.

### Transcription Concurrency

In the `MP3Handler` constructor:
```python
self.duration_pool = ThreadPoolExecutor(max_workers=15)
self.transcription_pool = ThreadPoolExecutor(max_workers=2)
```
- **`duration_pool`**: Used for checking file stability and reading durations. Increasing `max_workers` can speed up initial checks if files appear in large batches.
- **`transcription_pool`**: Used for the actual transcription calls. By default, `max_workers=2` helps avoid overloading your GPU.  
  - If you have a powerful GPU (e.g., high VRAM), you can increase `max_workers`.
  - If you’re running CPU-only, consider lowering this to 1 to avoid heavy CPU contention.

### Duration Threshold

```python
DURATION_THRESHOLD = 1.50
```
- Files with durations below `1.50` seconds are considered too short and will be moved to the “too short or error” directory without transcription.  
- Adjust if you want to transcribe very short files (or if you want a longer minimum duration).

### Re-encoding with FFmpeg

The script attempts to re-encode any file that fails metadata checks via:
```python
ffmpeg_command = ['ffmpeg', '-y', '-i', path, temp_path]
```
- You can customize these arguments (e.g., adding audio codecs or specific bitrates) if your source files need specialized handling.  
- If re-encoding fails, the file is ultimately moved to `TOO_SHORT_DIRECTORY`.

### Other Script Behaviors

- **Debouncing** (`DEBOUNCE_SECONDS`): Waits before re-processing the same file if multiple events fire in quick succession.
- **Stability Duration** (`STABILITY_DURATION`): Number of consecutive seconds a file size must remain unchanged before processing.
- **Output Organization**: The script extracts a “talkgroup ID” from the filename using a regex:  
  ```python
  re.search(r"TO_(\d+)[._]", filename)
  ```  
  If not found, the file and transcript are placed in an `unknown` subdirectory.

---

## Running on Different Hardware

- **GPU (CUDA)**: By default, the script attempts to load the model on `device="cuda"`. Ensure that you have the correct NVIDIA drivers and CUDA Toolkit installed, and that `faster-whisper` is installed in GPU mode.
- **CPU-Only**: If you lack an NVIDIA GPU or want to run on CPU, change:
  ```python
  self.model: Any = faster_whisper.WhisperModel(Config.MODEL_SIZE, device="cuda")
  ```
  to
  ```python
  self.model: Any = faster_whisper.WhisperModel(Config.MODEL_SIZE, device="cpu")
  ```
  Note that CPU-only transcription can be significantly slower, especially for large models.

- **Low-Power Devices** (like Raspberry Pi):  
  - Use the smallest model possible (`tiny` or `base`).
  - Lower concurrency by setting `max_workers=1` in both thread pools.
  - Increase your stability duration or reduce logging frequency for slower I/O.

---

## Running as a systemd Service

To have the transcription script run automatically on system boot and restart on failure, you can create a `systemd` service. This is especially useful for server environments where you want the transcriber to run continuously without user intervention.

### Example Service File

1. Create a file called **`/etc/systemd/system/sdrtrunk-transcriber.service`** (you will need `sudo` privileges to write here).  
2. Paste the following contents into it, adjusting paths to match your environment (e.g., your Python path, script location, user account, etc.):

   ```ini
   [Unit]
   Description=SDRTrunk Transcription Service
   After=network.target

   [Service]
   # If you want to run as a specific user, e.g. "pi" or "someuser":
   User=USERNAME
   Group=USERNAME

   # Change to the directory containing your transcriber script
   WorkingDirectory=/home/USERNAME/sdrTrunkTranscription/transcriber

   # Full path to Python interpreter and the transcriber script
   ExecStart=/usr/bin/python3 /home/USERNAME/sdrTrunkTranscription/transcriber/transcriber.py

   # If you are using a Python virtual environment, point to the venv Python:
   # ExecStart=/home/USERNAME/sdrTrunkTranscription/transcriber/venv/bin/python transcriber.py

   # Restart on failure
   Restart=on-failure
   RestartSec=5

   # Optional: If your script writes logs in the same folder, ensure systemd can write there
   # or rely on systemd's journal for logging.
   StandardOutput=journal
   StandardError=journal

   [Install]
   WantedBy=multi-user.target
   ```

   **Key Points**:
   - **`User` and `Group`**: Typically set these to a non-root user that has proper permissions to access the recording directories.  
   - **`WorkingDirectory`**: The folder containing `transcriber.py`.  
   - **`ExecStart`**: The command to run. Be sure it’s the correct path to Python (or your virtual environment’s `python` binary) and the script itself.  
   - **`Restart=on-failure`**: Ensures the service restarts automatically if it crashes.  
   - **`RestartSec=5`**: Wait 5 seconds before attempting to restart.

### Enabling and Starting the Service

Once the service file is in place:

1. **Reload systemd** to pick up the new service definition:
   ```bash
   sudo systemctl daemon-reload
   ```
2. **Enable** the service to start on boot:
   ```bash
   sudo systemctl enable sdrtrunk-transcriber.service
   ```
3. **Start** the service immediately:
   ```bash
   sudo systemctl start sdrtrunk-transcriber.service
   ```

### Managing the Service

- **Check status**:
  ```bash
  systemctl status sdrtrunk-transcriber.service
  ```
- **Stop** the service:
  ```bash
  sudo systemctl stop sdrtrunk-transcriber.service
  ```
- **Restart** the service (e.g., after configuration changes):
  ```bash
  sudo systemctl restart sdrtrunk-transcriber.service
  ```
- **View Logs** (via systemd’s journal):
  ```bash
  journalctl -u sdrtrunk-transcriber.service -f
  ```
  (The `-f` flag streams logs in real time, similar to `tail -f`.)

---

## Troubleshooting

- **No Transcriptions**  
  - Check that `.mp3` files are actually appearing in `ROOT_DIRECTORY`.  
  - Verify that the script has read/write permissions and that the paths are correct.
  - If using GPU, confirm `nvidia-smi` shows your GPU is recognized.

- **Script Crashes on Start**  
  - Ensure you’ve installed all dependencies (`watchdog`, `mutagen`, `faster-whisper`) and have `ffmpeg` installed system-wide.  
  - If running via `systemd`, ensure your `ExecStart` path and `WorkingDirectory` are correct.

- **Transcription Too Slow**  
  - Use a smaller model (e.g., `MODEL_SIZE="small"`).  
  - Lower the concurrency if your GPU/CPU is overloaded.

- **ffmpeg Errors**  
  - Ensure `ffmpeg` is in your system’s PATH.  
  - Add any extra parameters in the script’s `handle_reencode_and_retry` section as needed.

---

**We welcome contributions and feedback!** If you improve or modify the script for other hardware or use cases, feel free to open an issue or submit a pull request. Happy transcribing!