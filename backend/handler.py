from flask import Flask, request, jsonify, send_from_directory
import json
import os
import requests
import random
from urllib.parse import urlencode
from typing import Optional, List, Dict, Any
import logging
import boto3

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__, static_folder='../frontend', static_url_path='/static')

# Add URL prefix for API routes
app.url_map.strict_slashes = False
app.config['APPLICATION_ROOT'] = '/api'

# Initialize SSM client
ssm = boto3.client('ssm')

def get_parameter(param_name):
    response = ssm.get_parameter(
        Name=param_name,
        WithDecryption=True
    )
    return response['Parameter']['Value']

# Get environment variables
SPOTIFY_CLIENT_ID = get_parameter(os.environ['SPOTIFY_CLIENT_ID_PARAM'])
SPOTIFY_CLIENT_SECRET = get_parameter(os.environ['SPOTIFY_CLIENT_SECRET_PARAM'])
SPOTIFY_REDIRECT_URI = get_parameter(os.environ['SPOTIFY_REDIRECT_URI_PARAM'])

# Store access tokens (in production, use a proper session management)
user_tokens = {}

def get_playlist_tracks(token: str, playlist_id: str):
    """Helper function to get all tracks from a playlist"""
    tracks_response = requests.get(
        f"https://api.spotify.com/v1/playlists/{playlist_id}/tracks",
        headers={"Authorization": f"Bearer {token}"}
    )
    
    if tracks_response.status_code != 200:
        logger.error(f"Failed to fetch playlist tracks: {tracks_response.text}")
        return jsonify({"error": "Failed to fetch playlist tracks"}), 400
    
    return tracks_response.json()['items']

def select_tracks_for_duration(tracks: List[Dict[str, Any]], duration_minutes: int):
    """Helper function to select tracks up to a duration limit"""
    track_durations = []
    for track in tracks:
        if track['track']:
            track_durations.append({
                'uri': track['track']['uri'],
                'duration_ms': track['track']['duration_ms'],
                'name': track['track']['name'],
                'artist': track['track']['artists'][0]['name']
            })
    
    # Select tracks up to duration limit
    selected_tracks = []
    total_duration = 0
    duration_limit = duration_minutes * 60 * 1000  # Convert to milliseconds
    
    # Shuffle tracks for random selection
    random.shuffle(track_durations)
    
    for track in track_durations:
        if total_duration + track['duration_ms'] <= duration_limit:
            selected_tracks.append(track)
            total_duration += track['duration_ms']
        else:
            # Add one more track even if it exceeds the limit
            selected_tracks.append(track)
            total_duration += track['duration_ms']
            break
    
    return selected_tracks, total_duration

@app.route('/')
def root():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/login')
def login():
    scope = "user-read-private user-read-email playlist-read-private playlist-modify-private"
    params = {
        "client_id": SPOTIFY_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": SPOTIFY_REDIRECT_URI,
        "scope": scope
    }
    auth_url = f"https://accounts.spotify.com/authorize?{urlencode(params)}"
    return jsonify({"auth_url": auth_url})

@app.route('/callback')
def callback():
    code = request.args.get('code')
    if not code:
        return jsonify({"error": "No code provided"}), 400

    token_url = "https://accounts.spotify.com/api/token"
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": SPOTIFY_REDIRECT_URI,
        "client_id": SPOTIFY_CLIENT_ID,
        "client_secret": SPOTIFY_CLIENT_SECRET
    }
    response = requests.post(token_url, data=data)
    if response.status_code != 200:
        return jsonify({"error": "Failed to obtain access token"}), 400
    
    token_data = response.json()
    logger.info(f"Token data received: {token_data}")
    
    # Get user info to use as key for token storage
    user_info = requests.get(
        "https://api.spotify.com/v1/me",
        headers={"Authorization": f"Bearer {token_data['access_token']}"}
    ).json()
    
    logger.info(f"User info received: {user_info}")
    user_tokens[user_info['id']] = token_data
    return jsonify({"user_id": user_info['id']})

@app.route('/playlists/<user_id>')
def get_playlists(user_id):
    if user_id not in user_tokens:
        return jsonify({"error": "User not authenticated"}), 401
    
    token = user_tokens[user_id]['access_token']
    response = requests.get(
        "https://api.spotify.com/v1/me/playlists",
        headers={"Authorization": f"Bearer {token}"}
    )
    
    if response.status_code != 200:
        return jsonify({"error": "Failed to fetch playlists"}), 400
    
    return jsonify(response.json())

@app.route('/generate-playlist/<user_id>', methods=['POST'])
def generate_playlist(user_id):
    if user_id not in user_tokens:
        return jsonify({"error": "User not authenticated"}), 401
    
    body = request.get_json()
    source_playlist_id = body.get('source_playlist_id')
    duration_minutes = int(body.get('duration_minutes', 25))
    playlist_name = body.get('playlist_name')
    
    if not source_playlist_id:
        return jsonify({"error": "source_playlist_id is required"}), 400
    
    logger.info(f"Generating playlist for user {user_id}")
    logger.info(f"Request data: {body}")
    
    token = user_tokens[user_id]['access_token']
    
    # Get source playlist tracks
    tracks = get_playlist_tracks(token, source_playlist_id)
    logger.info(f"Found {len(tracks)} tracks in source playlist")
    
    # Select tracks for the duration
    selected_tracks, total_duration = select_tracks_for_duration(tracks, duration_minutes)
    logger.info(f"Selected {len(selected_tracks)} tracks")
    
    return jsonify({
        "tracks": selected_tracks,
        "total_duration_ms": total_duration,
        "track_count": len(selected_tracks)
    })

@app.route('/save-playlist/<user_id>', methods=['POST'])
def save_playlist(user_id):
    if user_id not in user_tokens:
        return jsonify({"error": "User not authenticated"}), 401
    
    body = request.get_json()
    track_uris = body.get('track_uris', [])
    playlist_name = body.get('playlist_name')
    
    if not track_uris:
        return jsonify({"error": "track_uris is required"}), 400
    if not playlist_name:
        return jsonify({"error": "playlist_name is required"}), 400
    
    logger.info(f"Saving playlist for user {user_id}")
    
    token = user_tokens[user_id]['access_token']
    
    # Create new playlist
    create_response = requests.post(
        f"https://api.spotify.com/v1/users/{user_id}/playlists",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        },
        json={
            "name": playlist_name,
            "public": False
        }
    )
    
    if create_response.status_code != 201:
        logger.error(f"Failed to create playlist: {create_response.text}")
        return jsonify({"error": "Failed to create playlist"}), 400
    
    new_playlist = create_response.json()
    logger.info(f"Created playlist: {new_playlist['id']}")
    
    # Add tracks to new playlist
    add_tracks_response = requests.post(
        f"https://api.spotify.com/v1/playlists/{new_playlist['id']}/tracks",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        },
        json={"uris": track_uris}
    )
    
    if add_tracks_response.status_code != 201:
        logger.error(f"Failed to add tracks: {add_tracks_response.text}")
        return jsonify({"error": "Failed to add tracks to playlist"}), 400
    
    logger.info("Successfully added tracks to playlist")
    
    return jsonify({
        "playlist_id": new_playlist['id'],
        "playlist_url": new_playlist['external_urls']['spotify']
    })

if __name__ == '__main__':
    app.run(debug=True) 