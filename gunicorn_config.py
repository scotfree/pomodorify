bind = "127.0.0.1:8000"
workers = 2
timeout = 120
accesslog = "-"
errorlog = "-"
wsgi_app = "backend.wsgi_handler:application" 