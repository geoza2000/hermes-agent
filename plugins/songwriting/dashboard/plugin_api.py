"""Load siblings by plugin directory, including when installed out of tree."""
from hashlib import sha256
from importlib import import_module
import logging
from pathlib import Path

from plugins.plugin_loader import load_plugin_module

root = Path(__file__).resolve().parents[1]
name = "plugins._songwriting_" + sha256(str(root).encode()).hexdigest()[:16]
backend = load_plugin_module(name, root, parents=("plugins",), logger=logging.getLogger(__name__))
if backend is None:
    raise ImportError("Unable to load songwriting backend")
router = import_module(name + ".api").router
