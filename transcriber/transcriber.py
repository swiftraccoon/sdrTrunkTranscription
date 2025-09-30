"""
SDR Trunk Transcription System

This application monitors a directory for MP3 recordings from SDR Trunk,
transcribes them using Whisper, and organizes the results by talkgroup.
"""
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
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional, Set, Tuple, Union

import faster_whisper
from mutagen.mp3 import MP3
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

# Default path configuration - should be customized for deployment
ROOT_DIRECTORY = "/home/USER/SDRTrunk/recordings"
TOO_SHORT_DIRECTORY = "/home/USER/SDRTrunk/tooShort"
ERROR_DIRECTORY = "/home/USER/SDRTrunk/errors"

# Configure logging with rotation
handler = TimedRotatingFileHandler(
    filename="sdrtrunk_transcription.log",
    when="D",         # Rotate by day
    interval=14,      # Every 14 days
    backupCount=5     # Keep last 5 log files
)
formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
handler.setFormatter(formatter)
logging.getLogger().setLevel(logging.INFO)
logging.getLogger().addHandler(handler)


class ProcessingError(Exception):
    """Base exception for all processing errors in the application."""
    pass


class FileStabilityError(ProcessingError):
    """Raised when a file does not stabilize within the expected time."""
    pass


class TranscriptionError(ProcessingError):
    """Raised when transcription of an audio file fails."""
    pass


class FileFormatError(ProcessingError):
    """Raised when there's an issue with the audio file format."""
    pass


@dataclass
class WhisperConfig:
    """Configuration parameters for Whisper transcription model."""
    # Core model parameters
    model_size: str = "large-v3" # vs distil-large-v3
    beam_size: int = 8
    patience: int = 8
    best_of: int = 6
    language: str = "en"
    
    # VAD parameters
    threshold: float = 0.42
    min_speech_duration_ms: int = 0
    max_speech_duration_s: float = float("inf")
    min_silence_duration_ms: int = 250
    speech_pad_ms: int = 800
    
    # Temperature control
    temperature: Tuple[float, ...] = field(default_factory=lambda: (0.01, 0.03, 0.09))
    
    # Additional parameters
    repetition_penalty: float = 1.1
    length_penalty: float = 1.0
    no_repeat_ngram_size: int = 0
    initial_prompt: Optional[str] = None
    suppress_blank: bool = True
    suppress_tokens: List[int] = field(default_factory=lambda: [-1])
    without_timestamps: bool = False
    word_timestamps: bool = False
    prepend_punctuations: str = "\"'([{-"
    append_punctuations: str = "\"'.,!?:)]}"
    vad_filter: bool = True
    max_new_tokens: Optional[int] = None
    chunk_length: Optional[int] = None
    clip_timestamps: str = "0"


@dataclass
class FileProcessingConfig:
    """Configuration for file processing behavior."""
    duration_threshold: float = 0.50  # Minimum duration in seconds to process
    debounce_seconds: float = 1.0     # Time to wait between processing same file
    stability_duration: int = 2       # Seconds file size must remain stable
    max_duration_workers: int = 15    # Workers for file stability checking
    max_transcription_workers: int = 2  # Workers for transcription (GPU intensive)


class TranscriptionService:
    """Handles the actual transcription of audio files using Whisper."""
    
    def __init__(self, config: WhisperConfig):
        self.config = config
        self.model = faster_whisper.WhisperModel(config.model_size, device="cuda")
    
    def transcribe(self, file_path: Path) -> str:
        """
        Transcribe an audio file and return the text result.
        
        Args:
            file_path: Path to the audio file to transcribe
            
        Returns:
            The transcribed text
            
        Raises:
            TranscriptionError: If transcription fails
        """
        try:
            segments, info = self.model.transcribe(
                str(file_path),
                beam_size=self.config.beam_size,
                patience=self.config.patience,
                best_of=self.config.best_of,
                repetition_penalty=self.config.repetition_penalty,
                length_penalty=self.config.length_penalty,
                no_repeat_ngram_size=self.config.no_repeat_ngram_size,
                initial_prompt=self.config.initial_prompt,
                suppress_blank=self.config.suppress_blank,
                suppress_tokens=self.config.suppress_tokens,
                without_timestamps=self.config.without_timestamps,
                word_timestamps=self.config.word_timestamps,
                prepend_punctuations=self.config.prepend_punctuations,
                append_punctuations=self.config.append_punctuations,
                temperature=self.config.temperature,
                vad_filter=self.config.vad_filter,
                vad_parameters={
                    "threshold": self.config.threshold,
                    "min_speech_duration_ms": self.config.min_speech_duration_ms,
                    "max_speech_duration_s": self.config.max_speech_duration_s,
                    "min_silence_duration_ms": self.config.min_silence_duration_ms,
                    "speech_pad_ms": self.config.speech_pad_ms
                },
                max_new_tokens=self.config.max_new_tokens,
                chunk_length=self.config.chunk_length,
                clip_timestamps=self.config.clip_timestamps,
                language=self.config.language
            )
            
            formatted_result = self._format_segments(segments)
            return json.loads(formatted_result)['text']
            
        except Exception as e:
            logging.exception(f"Transcription failed for {file_path}")
            raise TranscriptionError(f"Failed to transcribe {file_path}: {str(e)}") from e
    
    def _format_segments(self, segments) -> str:
        """
        Format transcription segments into a unified text string.
        
        Args:
            segments: Segments returned from the whisper model
            
        Returns:
            JSON string with a single "text" key containing the combined text
        """
        formatted_segments = [{"text": segment.text} for segment in segments]
        combined_text = " ".join(seg["text"].strip() for seg in formatted_segments)
        return json.dumps({"text": combined_text}).replace('": "', '":"')


class FileUtils:
    """Static utility methods for file operations."""
    
    @staticmethod
    def extract_talkgroup_id(filename: str) -> str:
        """
        Extract the talkgroup ID from a filename.
        
        Args:
            filename: Filename to extract from
            
        Returns:
            Talkgroup ID or "unknown" if not found
        """
        match = re.search(r"TO_(\d+)[._]", filename)
        return match.group(1) if match else "unknown"
    
    @staticmethod
    def get_audio_duration(file_path: Path) -> float:
        """
        Get the duration of an MP3 file in seconds.
        
        Args:
            file_path: Path to the MP3 file
            
        Returns:
            Duration in seconds
            
        Raises:
            FileFormatError: If the file cannot be read as an MP3
        """
        try:
            audio = MP3(file_path)
            return audio.info.length
        except Exception as e:
            logging.exception(f"Failed to read MP3 metadata for {file_path}")
            raise FileFormatError(f"Failed to read MP3 file {file_path}: {str(e)}") from e
    
    @staticmethod
    def wait_for_file_stability(file_path: Path, stability_duration: int) -> bool:
        """
        Wait for a file to reach a stable size.
        
        Args:
            file_path: Path to the file to monitor
            stability_duration: Seconds the file size must remain stable
            
        Returns:
            True if file stabilized, False otherwise
        """
        previous_size = -1
        stable_time = 0
        
        while stable_time < stability_duration:
            try:
                current_size = file_path.stat().st_size
                if current_size == previous_size:
                    stable_time += 1
                else:
                    stable_time = 0
                    previous_size = current_size
                time.sleep(1)
            except FileNotFoundError:
                logging.exception(f"File not found during stability check: {file_path}")
                return False
            except Exception as e:
                logging.exception(f"Error during file stability check for {file_path}")
                return False
        
        return True
    
    @staticmethod
    def reencode_file(source_path: Path, temp_path: Path) -> bool:
        """
        Re-encode an audio file using ffmpeg to fix potential issues.
        
        Args:
            source_path: Path to the source file
            temp_path: Path for the re-encoded output
            
        Returns:
            True if successful, False otherwise
        """
        try:
            ffmpeg_command = ['ffmpeg', '-y', '-i', str(source_path), str(temp_path)]
            logging.debug(f"Running ffmpeg command: {' '.join(ffmpeg_command)}")
            result = subprocess.run(ffmpeg_command, capture_output=True, text=True)
            
            if result.returncode != 0:
                logging.error(f"ffmpeg failed to re-encode {source_path}: {result.stderr}")
                return False
                
            if not temp_path.exists():
                logging.error(f"Re-encoded file not found: {temp_path}")
                return False
                
            return True
        except Exception as e:
            logging.exception(f"Error re-encoding {source_path}")
            return False


class FileProcessor:
    """
    Handles the processing pipeline for audio files:
    - Checks file stability and duration
    - Handles re-encoding for problematic files
    - Manages transcription and file organization
    """
    
    def __init__(
        self, 
        base_dir: Path,
        too_short_dir: Path,
        error_dir: Path,
        transcription_service: TranscriptionService,
        config: FileProcessingConfig
    ):
        self.base_dir = base_dir
        self.too_short_dir = too_short_dir
        self.error_dir = error_dir
        self.transcription_service = transcription_service
        self.config = config
        
        # Thread pools
        self.duration_pool = ThreadPoolExecutor(max_workers=config.max_duration_workers)
        self.transcription_pool = ThreadPoolExecutor(max_workers=config.max_transcription_workers)
        
        # Concurrency management
        self.file_locks: Dict[Path, threading.Lock] = {}
        self.file_times: Dict[Path, float] = {}
    
    def process_file(self, file_path: Path) -> None:
        """
        Process a newly detected audio file.
        
        Args:
            file_path: Path to the file to process
        """
        current_time = time.time()
        last_processed = self.file_times.get(file_path, 0)
        
        # Debounce: only process if enough time has passed
        if current_time - last_processed > self.config.debounce_seconds:
            self.file_times[file_path] = current_time
            logging.info(f"Processing MP3 file: {file_path}")
            self.duration_pool.submit(self._wait_and_process, file_path)
    
    def _wait_and_process(self, file_path: Path) -> None:
        """
        Wait for the file to stabilize, then process it based on duration.
        
        Args:
            file_path: Path to the file to process
        """
        try:
            if not FileUtils.wait_for_file_stability(file_path, self.config.stability_duration):
                logging.error(f"File did not stabilize: {file_path}")
                return
                
            self._check_duration_and_process(file_path)
                
        except Exception as e:
            logging.exception(f"Error processing {file_path}")
            self._move_to_error(file_path, f"Unexpected error: {str(e)}")
    
    def _check_duration_and_process(self, file_path: Path) -> None:
        """
        Check the duration of a file and process accordingly.
        
        Args:
            file_path: Path to the file to check
        """
        try:
            duration = FileUtils.get_audio_duration(file_path)
            logging.info(f"Processed {file_path}: Duration = {duration:.2f} seconds")
            
            if duration < self.config.duration_threshold:
                self._move_to_too_short(file_path)
            else:
                self.transcription_pool.submit(self._transcribe_and_organize, file_path)
                
        except FileFormatError:
            self._attempt_repair_and_retry(file_path)
    
    def _attempt_repair_and_retry(self, file_path: Path) -> None:
        """
        Attempt to repair a problematic audio file through re-encoding.
        
        Args:
            file_path: Path to the file to repair
        """
        temp_path = self.error_dir / f"{file_path.stem}_temp{file_path.suffix}"
        
        if FileUtils.reencode_file(file_path, temp_path):
            try:
                duration = FileUtils.get_audio_duration(temp_path)
                logging.info(f"Re-processed {temp_path}: Duration = {duration:.2f} seconds")
                
                if duration < self.config.duration_threshold:
                    # Move to too short and clean up
                    final_path = self.too_short_dir / file_path.name
                    file_path.unlink(missing_ok=True)  # Remove original
                    temp_path.rename(final_path)  # Move temp to final location
                    logging.info(f"Moved {temp_path} to {final_path} (below duration threshold).")
                else:
                    # Replace original with fixed version
                    file_path.unlink(missing_ok=True)  # Remove original
                    temp_path.rename(file_path)  # Replace with fixed version
                    self.transcription_pool.submit(self._transcribe_and_organize, file_path)
                    
            except Exception as e:
                logging.exception(f"Failed to process repaired file {temp_path}")
                temp_path.unlink(missing_ok=True)  # Clean up temp file
                self._move_to_error(file_path, f"Failed after repair attempt: {str(e)}")
        else:
            # Re-encoding failed
            self._move_to_error(file_path, "Failed to repair file through re-encoding")
    
    def _transcribe_and_organize(self, file_path: Path) -> None:
        """
        Transcribe a file and organize it by talkgroup ID.
        
        Args:
            file_path: Path to the file to transcribe
        """
        lock = self.file_locks.setdefault(file_path, threading.Lock())
        
        with lock:
            if not file_path.exists():
                logging.error(f"File not found for transcription: {file_path}")
                if file_path in self.file_locks:
                    del self.file_locks[file_path]
                return
                
            try:
                # Get transcription
                transcription_text = self.transcription_service.transcribe(file_path)
                
                # Get talkgroup ID and prepare target directory
                talkgroup_id = FileUtils.extract_talkgroup_id(file_path.name)
                target_dir = self.base_dir / talkgroup_id
                target_dir.mkdir(exist_ok=True)
                
                # Create text file with transcription
                text_path = target_dir / f"{file_path.stem}.txt"
                text_path.write_text(transcription_text)
                
                # Move MP3 file to target directory
                target_path = target_dir / file_path.name
                file_path.rename(target_path)
                
                logging.info(f"Transcribed and moved {file_path} -> {target_dir}")
                
            except TranscriptionError as e:
                logging.error(f"Transcription error: {str(e)}")
                self._move_to_error(file_path, f"Transcription failed: {str(e)}")
                
            except Exception as e:
                logging.exception(f"Unexpected error during transcription of {file_path}")
                self._move_to_error(file_path, f"Unexpected error: {str(e)}")
                
            finally:
                # Remove lock so future events for the same file can proceed
                if file_path in self.file_locks:
                    del self.file_locks[file_path]
    
    def _move_to_too_short(self, file_path: Path) -> None:
        """
        Move a file to the 'too short' directory.
        
        Args:
            file_path: Path to the file to move
        """
        dest_path = self.too_short_dir / file_path.name
        file_path.rename(dest_path)
        logging.info(f"Moved {file_path} to {dest_path} (below duration threshold).")
    
    def _move_to_error(self, file_path: Path, reason: str) -> None:
        """
        Move a file to the error directory.
        
        Args:
            file_path: Path to the file to move
            reason: Reason for the move
        """
        if file_path.exists():
            dest_path = self.error_dir / file_path.name
            try:
                file_path.rename(dest_path)
                logging.info(f"Moved {file_path} to {dest_path}: {reason}")
            except Exception as e:
                logging.error(f"Failed to move {file_path} to error directory: {str(e)}")


class MP3Handler(FileSystemEventHandler):
    """
    Monitors directory for new MP3 files and processes them.
    """
    
    def __init__(self, processor: FileProcessor, base_dir: Path):
        super().__init__()
        self.processor = processor
        self.base_dir = base_dir
        self.observer = Observer()
    
    def on_created(self, event) -> None:
        """
        Handle file creation events.
        
        Args:
            event: The file system event
        """
        if event.is_directory:
            return
            
        file_path = Path(event.src_path)
        if file_path.suffix.lower() != '.mp3':
            return
            
        # Only process files directly in the base directory
        if file_path.parent != self.base_dir:
            return
            
        self.processor.process_file(file_path)
    
    def process_existing_files(self) -> None:
        """
        Process MP3 files that already exist in the base directory.
        """
        for file_path in self.base_dir.glob('*.mp3'):
            self.processor.process_file(file_path)
    
    def start(self) -> None:
        """
        Start monitoring the directory.
        """
        # Process existing files first
        self.process_existing_files()
        
        # Set up directory monitoring
        self.observer.schedule(self, str(self.base_dir), recursive=False)
        self.observer.start()
        
        try:
            self.observer.join()
        except KeyboardInterrupt:
            self.stop()
    
    def stop(self) -> None:
        """
        Stop monitoring the directory.
        """
        self.observer.stop()
        self.observer.join()
        logging.info("Monitoring stopped.")


def main():
    """Main entry point for the application."""
    # Convert string paths to Path objects
    base_dir = Path(ROOT_DIRECTORY)
    too_short_dir = Path(TOO_SHORT_DIRECTORY)
    error_dir = Path(ERROR_DIRECTORY)
    
    # Ensure directories exist
    base_dir.mkdir(exist_ok=True)
    too_short_dir.mkdir(exist_ok=True)
    error_dir.mkdir(exist_ok=True)
    
    # Create configuration objects
    whisper_config = WhisperConfig()
    file_config = FileProcessingConfig()
    
    # Set up the transcription service
    transcription_service = TranscriptionService(whisper_config)
    
    # Create the file processor
    processor = FileProcessor(
        base_dir=base_dir,
        too_short_dir=too_short_dir,
        error_dir=error_dir,
        transcription_service=transcription_service,
        config=file_config
    )
    
    # Create and start the file handler
    handler = MP3Handler(processor, base_dir)
    
    # Set up signal handling for graceful shutdown
    signal.signal(signal.SIGINT, lambda sig, frame: handler.stop())
    
    logging.info(f"Starting SDR Trunk Transcription monitoring of {base_dir}")
    handler.start()


if __name__ == "__main__":
    main()