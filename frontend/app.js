let userId = null;
let currentPreview = null;

document.getElementById('login-button').addEventListener('click', async () => {
    try {
        const response = await fetch('/api/login');
        const data = await response.json();
        window.location.href = data.auth_url;
    } catch (error) {
        console.error('Login failed:', error);
        alert('Failed to log in. Please try again.');
    }
});

window.addEventListener('load', async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    
    if (code) {
        try {
            const response = await fetch(`/api/callback?code=${code}`);
            const data = await response.json();
            userId = data.user_id;
            
            // Remove the code from URL
            window.history.replaceState({}, document.title, window.location.pathname);
            
            // Show playlist section and load playlists
            document.getElementById('login-section').style.display = 'none';
            document.getElementById('playlist-section').style.display = 'block';
            await loadPlaylists();
        } catch (error) {
            console.error('Callback failed:', error);
            alert('Failed to authenticate. Please try again.');
        }
    }
});

async function loadPlaylists() {
    try {
        const response = await fetch(`/api/playlists/${userId}`);
        if (!response.ok) {
            throw new Error('Failed to fetch playlists');
        }
        const data = await response.json();
        
        const select = document.getElementById('playlist-select');
        select.innerHTML = '';
        
        data.items.forEach(playlist => {
            const option = document.createElement('option');
            option.value = playlist.id;
            option.textContent = playlist.name;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Failed to load playlists:', error);
        alert('Failed to load playlists. Please try again.');
    }
}

document.getElementById('generate-button').addEventListener('click', async () => {
    const playlistId = document.getElementById('playlist-select').value;
    const duration = parseInt(document.getElementById('duration').value);
    const playlistName = document.getElementById('playlist-name').value;
    
    try {
        const response = await fetch(`/api/generate-playlist/${userId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                source_playlist_id: playlistId,
                duration_minutes: duration,
                playlist_name: playlistName
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to generate playlist');
        }
        
        const data = await response.json();
        currentPreview = data;
        
        // Display preview
        document.getElementById('preview-duration').textContent = formatDuration(data.total_duration_ms);
        document.getElementById('preview-track-count').textContent = data.track_count;
        
        const trackList = document.getElementById('preview-tracks');
        trackList.innerHTML = '';
        
        data.tracks.forEach(track => {
            const trackItem = document.createElement('div');
            trackItem.className = 'track-item';
            trackItem.innerHTML = `
                <div class="track-info">
                    <div class="track-name">${track.name}</div>
                    <div class="track-artist">${track.artist}</div>
                </div>
                <div class="track-duration">${formatDuration(track.duration_ms)}</div>
            `;
            trackList.appendChild(trackItem);
        });
        
        // Show preview section
        document.getElementById('playlist-section').style.display = 'none';
        document.getElementById('preview-section').style.display = 'block';
    } catch (error) {
        console.error('Failed to generate playlist:', error);
        alert('Failed to generate playlist. Please try again.');
    }
});

document.getElementById('regenerate-button').addEventListener('click', () => {
    document.getElementById('generate-button').click();
});

document.getElementById('save-button').addEventListener('click', async () => {
    if (!currentPreview) {
        alert('No playlist to save. Please generate a playlist first.');
        return;
    }
    
    const playlistName = document.getElementById('playlist-name').value || 
        `Pomodoro Playlist (${formatDuration(currentPreview.total_duration_ms)})`;
    
    try {
        const response = await fetch(`/api/save-playlist/${userId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                track_uris: currentPreview.tracks.map(track => track.uri),
                playlist_name: playlistName
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to save playlist');
        }
        
        const data = await response.json();
        
        // Show result
        document.getElementById('preview-section').style.display = 'none';
        document.getElementById('result-section').style.display = 'block';
        document.getElementById('playlist-link').href = data.playlist_url;
    } catch (error) {
        console.error('Failed to save playlist:', error);
        alert('Failed to save playlist. Please try again.');
    }
});

document.getElementById('create-another-button').addEventListener('click', () => {
    document.getElementById('result-section').style.display = 'none';
    document.getElementById('playlist-section').style.display = 'block';
});

function formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
