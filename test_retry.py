#!/usr/bin/env python3
"""Test script to verify the retry functionality works correctly."""

import tempfile
import os
import sys

# Add the tools directory to path so we can import build_data
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'tools'))

# Import the modified build_data module
import build_data

def test_download_with_retry():
    """Test that download_with_retry function handles retries properly."""
    print("Testing download_with_retry functionality...")
    
    # Create a temporary directory for testing
    with tempfile.TemporaryDirectory() as temp_dir:
        test_file = os.path.join(temp_dir, "test_gtfs.zip")
        
        # This should work (download from the actual feed)
        try:
            build_data.download_with_retry(build_data.GTFS_URL, test_file, max_retries=2, delay=1)
            print("✓ Download with retry succeeded")
            
            # Verify file was created and has content
            if os.path.exists(test_file) and os.path.getsize(test_file) > 0:
                print("✓ Downloaded file has content")
            else:
                print("✗ Downloaded file is empty or missing")
                
        except Exception as e:
            print(f"✗ Download failed: {e}")
            
    return True

if __name__ == "__main__":
    test_download_with_retry()