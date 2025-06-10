import sys
import os

# Add the current directory to Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from handler import app

# This is the WSGI application that Gunicorn will use
application = app 