import json
import logging
from logging.handlers import TimedRotatingFileHandler
import os
import re
import shutil
import signal
import sys
import threading
import time
import subprocess

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Tuple, Optional, List

import faster_whisper
from mutagen.mp3 import MP3
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

ROOT_DIRECTORY = "/home/USER/SDRTrunk/recordings"
TOO_SHORT_DIRECTORY = "/home/USER/SDRTrunk/tooShort"
ERROR_DIRECTORY = "/home/USER/SDRTrunk/errors"

# Configure logging
# Create a timed rotating file handler
# Rotate every 14 days (2 weeks), keep last 5 backups
handler = TimedRotatingFileHandler(
    filename="sdrtrunk_transcription.log",
    when="D",         # Rotate by day
    interval=14,      # Every 14 days
    backupCount=5     # Keep last 5 log files
)

# Configure formatter
formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
handler.setFormatter(formatter)

# Set up the root logger
logging.getLogger().setLevel(logging.INFO)
logging.getLogger().addHandler(handler)


class Config:
    """
    Holds all configuration constants for the transcription and file handling.
    """
    # Core whisper model parameters
    MODEL_SIZE: str = "distil-large-v3" # "large-v3" or "medium"
    BEAM_SIZE: int = 12          # Beam size to use for decoding
    PATIENCE: int = 18           # Beam search patience factor
    BEST_OF: int = 80             # Number of candidates when sampling with non-zero temperature
    LANGUAGE: str = "en"         # Language code for transcription (e.g., "en", "fr", etc.)

    # Voice Activity Detection (VAD) parameters
    # Speech threshold. VAD outputs probabilities for each audio chunk,
    # probabilities ABOVE this value are considered as SPEECH.
    THRESHOLD: float = 0.42
    
    # Final speech chunks shorter than min_speech_duration_ms are filtered out
    MIN_SPEECH_DURATION_MS: int = 0
    
    # Maximum duration of speech chunks in seconds. Longer chunks will be split
    # at the timestamp of the last silence (>100ms), or aggressively if no silence found.
    MAX_SPEECH_DURATION_S: float = float("inf")
    
    # In the end of each speech chunk, wait for min_silence_duration_ms before separating it
    MIN_SILENCE_DURATION_MS: int = 250
    
    # Final speech chunks are padded by speech_pad_ms on each side
    SPEECH_PAD_MS: int = 800
    
    # Temperature control
    # Temperature for sampling. It can be a tuple of temperatures,
    # which will be successively used upon failures according to thresholds.
    TEMPERATURE: Tuple[float, float, float] = (0.01, 0.03, 0.09)

    # Additional transcription parameters
    REPETITION_PENALTY: float = 1.1       # Penalty applied to repeated tokens (>1 to penalize)
    LENGTH_PENALTY: float = 1.0           # Exponential length penalty constant
    NO_REPEAT_NGRAM_SIZE: int = 0         # Prevent repetitions of ngrams with this size (0 to disable)
    
    # Initial prompt for the first window (None for no prompt)
    INITIAL_PROMPT: Optional[str] = None
    
    # Suppress blank outputs at beginning of sampling
    SUPPRESS_BLANK: bool = True
    
    # List of token IDs to suppress during generation (-1 for default non-speech tokens)
    SUPPRESS_TOKENS: Optional[List[int]] = [-1]
    
    # Only sample text tokens without timestamps
    WITHOUT_TIMESTAMPS: bool = False
    
    # Extract word-level timestamps using cross-attention pattern
    WORD_TIMESTAMPS: bool = False
    
    # If word_timestamps is True, merge these punctuation symbols with the next word
    PREPEND_PUNCTUATIONS: str = "\"'([{-"
    
    # If word_timestamps is True, merge these punctuation symbols with the previous word
    APPEND_PUNCTUATIONS: str = "\"'.,!?:)]}"
    
    # Enable VAD filter to remove parts without speech
    VAD_FILTER: bool = True
    
    # Maximum number of new tokens to generate per chunk
    MAX_NEW_TOKENS: Optional[int] = None
    
    # The length of audio segments (in seconds)
    CHUNK_LENGTH: Optional[int] = None
    
    # Timestamps for clipping audio (format: "start,end,start,end,...")
    CLIP_TIMESTAMPS: str = "0"

    # File handling and concurrency
    DURATION_THRESHOLD: float = 1.50
    DEBOUNCE_SECONDS: float = 1.0
    STABILITY_DURATION: int = 2


class MP3Handler(FileSystemEventHandler):
    """
    FileSystemEventHandler subclass that processes .mp3 files in a directory:
    1) Waits for newly created files to stabilize in size.
    2) Checks duration; moves short files to an error directory.
    3) Transcribes longer files using a limited worker pool for GPU usage.
    """

    def __init__(self, base_directory: str, too_short_directory: str, error_directory: str) -> None:
        super().__init__()

        # Base directories
        self.base_directory: str = os.path.abspath(base_directory)
        self.too_short_directory: str = os.path.abspath(too_short_directory)
        self.error_directory: str = os.path.abspath(error_directory)

        os.makedirs(self.too_short_directory, exist_ok=True)
        os.makedirs(self.error_directory, exist_ok=True)

        # Thread pools:
        #  - High concurrency for file-size stability checks
        #  - Limited concurrency for GPU-intensive transcription
        self.duration_pool: ThreadPoolExecutor = ThreadPoolExecutor(max_workers=15)
        self.transcription_pool: ThreadPoolExecutor = ThreadPoolExecutor(max_workers=2)

        # GPU-based Whisper model
        self.model: Any = faster_whisper.WhisperModel(Config.MODEL_SIZE, device="cuda")

        # Lock dictionary for concurrency control on each file
        self.file_locks = {}

        # Debounce dictionary to avoid processing the same file multiple times in quick succession
        self.file_times = {}

        # Watchdog observer
        self.observer = Observer()

    def start(self) -> None:
        """
        Starts monitoring the base directory for new MP3 files, processes existing files,
        and keeps the observer running until stopped or interrupted.
        """
        # Optionally process existing .mp3 files in the root directory first
        self.process_existing_files()

        # Schedule this handler (recursively or non-recursively, as you prefer)
        self.observer.schedule(self, self.base_directory, recursive=True)
        self.observer.start()

        try:
            # Keep the thread alive
            self.observer.join()
        except KeyboardInterrupt:
            self.stop()

    def stop(self) -> None:
        """
        Stops monitoring, shuts down thread pools, and exits the program.
        """
        self.observer.stop()
        self.observer.join()
        self.duration_pool.shutdown(wait=True)
        self.transcription_pool.shutdown(wait=True)
        logging.info("Monitoring stopped.")
        sys.exit(0)

    def on_created(self, event) -> None:
        """
        Called when a new file is created in the monitored directory.
        We debounce events to avoid repeated triggers for the same file.
        """
        if event.is_directory:
            return
        if not event.src_path.endswith('.mp3'):
            return

        file_path = os.path.abspath(event.src_path)
        current_time = time.time()
        last_processed = self.file_times.get(file_path, 0)

        # Debounce: only process if enough time has passed
        if current_time - last_processed > Config.DEBOUNCE_SECONDS:
            self.file_times[file_path] = current_time
            logging.info(f"New MP3 file detected: {file_path}")
            self.duration_pool.submit(self.wait_and_process_file, file_path)

    def process_existing_files(self) -> None:
        """
        Optionally process any .mp3 files that already exist in the base directory
        at the time the script starts.
        """
        for root, dirs, files in os.walk(self.base_directory, topdown=True):
            for filename in files:
                if filename.endswith('.mp3'):
                    full_path = os.path.join(root, filename)
                    # If you only want to process items directly in the base directory (not subfolders):
                    if os.path.dirname(full_path) == self.base_directory:
                        self.duration_pool.submit(self.wait_and_process_file, full_path)

    def wait_and_process_file(self, path: str) -> None:
        """
        Wait for the file size to remain stable for a given duration, then process it.
        """
        stable = self.wait_for_file_stability(path, Config.STABILITY_DURATION)
        if stable:
            self.process_file(path)
        else:
            logging.error(f"File did not stabilize: {path}")

    def wait_for_file_stability(self, path: str, stability_duration: int = 2) -> bool:
        """
        Checks if the file size remains the same for `stability_duration` consecutive seconds.
        Returns True if stable, False otherwise.
        """
        previous_size = -1
        stable_time = 0

        while stable_time < stability_duration:
            try:
                current_size = os.path.getsize(path)
                if current_size == previous_size:
                    stable_time += 1
                else:
                    stable_time = 0
                    previous_size = current_size
                time.sleep(1)
            except FileNotFoundError:
                logging.exception(f"File not found during stability check: {path}")
                return False
            except Exception:
                logging.exception(f"Error during file stability check for {path}")
                return False

        return True

    def process_file(self, path: str) -> None:
        """
        Reads the MP3 duration. If shorter than threshold, move to the 'too_short' directory.
        Otherwise, submit the file for transcription.
        If any issue occurs reading the MP3, attempts re-encoding.
        """
        if not path.endswith('.mp3'):
            return

        file_dir = os.path.dirname(os.path.abspath(path))
        if file_dir != self.base_directory:
            logging.debug(f"Ignoring file not in root directory: {path}")
            return

        try:
            audio = MP3(path)
            duration = audio.info.length
            logging.info(f"Processed {path}: Duration = {duration:.2f} seconds")

            if duration < Config.DURATION_THRESHOLD:
                dest_path = os.path.join(self.too_short_directory, os.path.basename(path))
                shutil.move(path, dest_path)
                logging.info(f"Moved {path} to {dest_path} (below duration threshold).")
            else:
                # Submit to GPU-limited pool
                self.transcription_pool.submit(self.transcribe_and_move, path)

        except Exception:
            logging.exception(f"Failed to read MP3 metadata for {path}. Will attempt to re-encode.")
            self.handle_reencode_and_retry(path)

    def handle_reencode_and_retry(self, path: str) -> None:
        """
        Re-encode the file via FFmpeg to fix any issues, then re-check duration and
        move/transcribe accordingly. Moves file to error_directory if all else fails.
        """
        temp_path = self.get_temp_path(path)

        try:
            ffmpeg_command = ['ffmpeg', '-y', '-i', path, temp_path]
            logging.debug(f"Running ffmpeg command: {' '.join(ffmpeg_command)}")
            result = subprocess.run(ffmpeg_command, capture_output=True, text=True)

            if result.returncode != 0:
                logging.error(f"ffmpeg failed to re-encode {path}: {result.stderr}")
                raise Exception("ffmpeg re-encode failed")

            if not os.path.exists(temp_path):
                raise FileNotFoundError(f"Re-encoded file not found: {temp_path}")

            # Check re-encoded file's duration
            audio = MP3(temp_path)
            duration = audio.info.length
            logging.info(f"Re-processed {temp_path}: Duration = {duration:.2f} seconds")

            if duration < Config.DURATION_THRESHOLD:
                final_path = os.path.join(self.too_short_directory, os.path.basename(path))
                os.remove(path)  # Remove original
                os.rename(temp_path, final_path)  # Move temp
                logging.info(f"Moved {temp_path} to {final_path} (below duration threshold).")
            else:
                final_path = os.path.join(self.base_directory, os.path.basename(path))
                os.remove(path)  # Remove original
                os.rename(temp_path, final_path)  # Now safe to transcribe
                self.transcription_pool.submit(self.transcribe_and_move, final_path)

        except Exception:
            logging.exception(f"Failed to re-process {path} after re-encoding.")
            if os.path.exists(temp_path):
                os.remove(temp_path)  # Clean up
            # Move original to error directory since re-encoding failed
            error_dest_path = os.path.join(
                self.error_directory, os.path.basename(path))
            shutil.move(path, error_dest_path)
            logging.info(f"Moved original {path} to {error_dest_path} after repeated failures.")

    def get_temp_path(self, original_path: str) -> str:
        """
        Generate a temporary file path in the 'error_directory' with '_temp' suffix
        to avoid collisions.
        """
        base_name = os.path.basename(original_path)
        base, ext = os.path.splitext(base_name)
        if not base.endswith('_temp'):
            temp_base = base + '_temp' + ext
            return os.path.join(self.error_directory, temp_base)
        else:
            return original_path  # If it's already a temp file, just return as is

    def transcribe_and_move(self, path: str) -> None:
        """
        Acquire a lock for this file, transcribe it, write text output, and then
        move MP3 + text into a subfolder named after the talkgroup ID.
        """
        lock = self.file_locks.setdefault(path, threading.Lock())
        with lock:
            if not os.path.exists(path):
                logging.error(f"File not found for transcription: {path}")
                del self.file_locks[path]
                return

            try:
                segments, info = self.model.transcribe(
                    path,
                    beam_size=Config.BEAM_SIZE,
                    patience=Config.PATIENCE,
                    best_of=Config.BEST_OF,
                    repetition_penalty=Config.REPETITION_PENALTY,
                    length_penalty=Config.LENGTH_PENALTY,
                    no_repeat_ngram_size=Config.NO_REPEAT_NGRAM_SIZE,
                    initial_prompt=Config.INITIAL_PROMPT,
                    suppress_blank=Config.SUPPRESS_BLANK,
                    suppress_tokens=Config.SUPPRESS_TOKENS,
                    without_timestamps=Config.WITHOUT_TIMESTAMPS,
                    word_timestamps=Config.WORD_TIMESTAMPS,
                    prepend_punctuations=Config.PREPEND_PUNCTUATIONS,
                    append_punctuations=Config.APPEND_PUNCTUATIONS,
                    temperature=Config.TEMPERATURE,
                    vad_filter=Config.VAD_FILTER,
                    vad_parameters={
                        "threshold": Config.THRESHOLD,
                        "min_speech_duration_ms": Config.MIN_SPEECH_DURATION_MS,
                        "max_speech_duration_s": Config.MAX_SPEECH_DURATION_S,
                        "min_silence_duration_ms": Config.MIN_SILENCE_DURATION_MS,
                        "speech_pad_ms": Config.SPEECH_PAD_MS
                    },
                    max_new_tokens=Config.MAX_NEW_TOKENS,
                    chunk_length=Config.CHUNK_LENGTH,
                    clip_timestamps=Config.CLIP_TIMESTAMPS,
                    language=Config.LANGUAGE
                )

                formatted_result = self.format_segments(segments)
                transcription_text = json.loads(formatted_result)['text']

                talkgroup_id = self.extract_talkgroup_id(os.path.basename(path))
                final_directory = os.path.join(self.base_directory, talkgroup_id)
                os.makedirs(final_directory, exist_ok=True)

                # Create text filename based on the MP3 filename (minus extension)
                base_filename = os.path.splitext(os.path.basename(path))[0]
                transcription_path = os.path.join(final_directory, base_filename + ".txt")
                with open(transcription_path, 'w') as f:
                    f.write(transcription_text)

                final_mp3_path = os.path.join(final_directory, os.path.basename(path))
                shutil.move(path, final_mp3_path)
                logging.info(f"Transcribed and moved {path} -> {final_directory}")

            except Exception:
                logging.exception(f"Failed to transcribe {path}")
                # Move file to error directory on transcription failure
                error_dest_path = os.path.join(self.error_directory, os.path.basename(path))
                shutil.move(path, error_dest_path)
                logging.info(f"Moved {path} to {error_dest_path} after transcription failure.")

            finally:
                # Remove lock so future events for the same file can proceed
                del self.file_locks[path]

    def format_segments(self, segments) -> str:
        """
        Take a list of segment objects, extract .text, join into a single string,
        and wrap it in JSON with key "text".
        """
        formatted_segments = [{"text": segment.text} for segment in segments]
        combined_text = " ".join(seg["text"].strip() for seg in formatted_segments)

        # Return JSON with a single top-level key 'text'
        return json.dumps({"text": combined_text}).replace('": "', '":"')

    def extract_talkgroup_id(self, filename: str) -> str:
        """
        Extract talkgroup ID from filename if it matches 'TO_<digits>.' or 'TO_<digits>_'.
        Returns 'unknown' if not found.
        """
        match = re.search(r"TO_(\d+)[._]", filename)
        return match.group(1) if match else "unknown"


def start_monitoring(base_directory: str, too_short_directory: str, error_directory: str) -> None:
    """
    Helper function to set up the MP3Handler, attach a signal handler, and begin monitoring.
    """
    handler = MP3Handler(base_directory, too_short_directory, error_directory)
    # Allow Ctrl+C to gracefully stop the observer and shut down
    signal.signal(signal.SIGINT, lambda sig, frame: handler.stop())
    handler.start()


if __name__ == "__main__":
    start_monitoring(ROOT_DIRECTORY, TOO_SHORT_DIRECTORY, ERROR_DIRECTORY)