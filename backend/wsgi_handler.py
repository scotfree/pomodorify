from handler import app

def handler(event, context):
    from serverless_wsgi import handle_request
    return handle_request(app, event, context) 