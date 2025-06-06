import sys
import os

# Add the current directory to Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from handler import app

def handler(event, context):
    from serverless_wsgi import handle_request
    return handle_request(app, event, context) 