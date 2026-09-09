import os
import sys
import subprocess
import logging
from pathlib import Path
from data_ingestion import process_batch_reports

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def get_base_path():
    """
    Get the correct base path whether running as a Python script
    or a PyInstaller bundled executable.
    """
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        return Path(sys._MEIPASS)
    return Path(__file__).parent.resolve()

def node_pdf_generator(report_data):
    """
    Callback function that triggers the Node.js PDF generation pipeline.
    """
    temp_dir = report_data.get('__temp_dir')
    json_file_name = report_data.get('__json_file_name')
    
    if not temp_dir or not json_file_name:
        raise ValueError("Missing temporary directory or JSON file name from ingestion pipeline.")

    base_path = get_base_path()
    generate_js_path = base_path / "scripts" / "generate.js"
    
    # Save the output PDF in the Processed directory
    project_root = Path(__file__).parent.resolve()
    pdf_name = f"{Path(json_file_name).stem}_Report.pdf"
    output_pdf_path = project_root / "Processed" / pdf_name
    output_pdf_path.parent.mkdir(parents=True, exist_ok=True)
    
    logging.info(f"Triggering Node.js generator for {json_file_name}...")
    
    # Execute Node.js pipeline via subprocess
    result = subprocess.run(
        ["node", str(generate_js_path), str(temp_dir), str(json_file_name), str(output_pdf_path)],
        cwd=str(base_path),
        capture_output=True,
        text=True,
        encoding="utf-8"
    )
    
    if result.returncode != 0:
        logging.error(f"Node.js generator failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}")
        raise RuntimeError("PDF Generation failed via Node.js")
    
    logging.info(f"Node.js generator succeeded. PDF generated at: {output_pdf_path}")

if __name__ == "__main__":
    logging.info("Starting Batch Processing Loop...")
    process_batch_reports(node_pdf_generator)
    logging.info("Batch Processing Loop Complete.")
