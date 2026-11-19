#!/usr/bin/env python3
"""Stands in for the transcriber: writes <outdir>/<audio stem>.txt."""
import sys
from pathlib import Path

Path(sys.argv[2], f"{Path(sys.argv[1]).stem}.txt").write_text("hello from the stub\n")
