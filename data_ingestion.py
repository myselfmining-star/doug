import os
import shutil
import json
import zipfile
import tempfile
import logging
from pathlib import Path
from contextlib import contextmanager

# Set up logging for the batch processing
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Define persistent directories at the project root
BASE_DIR = Path(__file__).parent.resolve()
REPORT_DATA_DIR = BASE_DIR / "Report Data"
PROCESSED_DIR = BASE_DIR / "Processed"
FAILED_DIR = BASE_DIR / "Failed"

def setup_directories():
    """Ensure that the persistent staging directories exist."""
    for directory in [REPORT_DATA_DIR, PROCESSED_DIR, FAILED_DIR]:
        directory.mkdir(parents=True, exist_ok=True)


@contextmanager
def ingest_report_package(zip_path):
    """
    Context manager to ingest a report zip package.
    Extracts the zip to a temporary directory, parses JSON data,
    injects absolute local image paths, and automatically cleans up
    when the context exits.
    """
    with tempfile.TemporaryDirectory() as temp_dir:
        # 1. Secure Extraction
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(temp_dir)
            
        json_data = None
        image_assets = {}
        
        # 2. Dynamic Asset Targeting
        # Traverse the unpredictable subfolder structure
        for root, _, files in os.walk(temp_dir):
            for file in files:
                file_path = Path(root) / file
                ext = file_path.suffix.lower()
                
                # Locate the single JSON file
                if ext == '.json' and json_data is None:
                    json_file_name = file
                    data_subfolder = root  # Capture the actual subfolder containing the JSON
                    with open(file_path, 'r', encoding='utf-8') as f:
                        json_data = json.load(f)
                
                # Locate image assets
                elif ext in {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'}:
                    # Map image filename to its absolute local path
                    image_assets[file] = str(file_path.absolute())
                    
        if json_data is None:
            raise FileNotFoundError(f"No JSON data file found in the extracted zip: {zip_path}")
            
        # 3. Data Parsing & Path Injection
        # Ensure json_data is a dictionary
        if not isinstance(json_data, dict):
            json_data = {"raw_content": json_data}
            
        # Inject the absolute local file paths of the extracted images
        json_data['local_image_assets'] = image_assets
        

        # Inject metadata for Node.js execution
        json_data['__temp_dir'] = temp_dir 
        json_data['__json_file_name'] = str(Path(data_subfolder) / json_file_name)
        
        # Yield the processed data dictionary. 
        # Downstream PDF generators can now use `local_image_assets` 
        # which point directly to the temporary directory.
        yield json_data

def process_batch_reports(pdf_generator_callback):
    """
    Scans the Report Data directory for incoming .zip files, processes them,
    and moves them to either the Processed or Failed directories based on success.
    
    Args:
        pdf_generator_callback: A function that takes `report_data` (dict) as an argument
                                and generates the PDF. Should raise an exception on failure.
    """
    # Programmatically ensure our persistent staging directories exist on startup
    setup_directories()
    
    # Locate all .zip files in the incoming Report Data folder
    incoming_zips = list(REPORT_DATA_DIR.glob("*.zip"))
    
    if not incoming_zips:
        logging.info("No incoming .zip files found in the 'Report Data' directory.")
        return
        
    for zip_path in incoming_zips:
        logging.info(f"Initiating processing for: {zip_path.name}")
        
        try:
            # Wrap execution in the context manager for automated cleanup
            with ingest_report_package(zip_path) as report_data:
                # Execute the provided downstream PDF generation
                pdf_generator_callback(report_data)
                
            # If the context manager exits cleanly and no exception was raised,
            # the PDF was successfully generated. 
            logging.info(f"Success! Generated PDF for {zip_path.name} (left in Report Data).")
            
        except Exception as e:
            # If an error occurs during extraction, parsing, or generation,
            # capture the exception.
            logging.error(f"Failed processing {zip_path.name}: {e}")
            logging.info(f"File {zip_path.name} left in Report Data for review.")

