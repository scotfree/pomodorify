class PomodorifyApp {
    constructor() {
        this.clientId = 'bac207f49dc041e0a2e8a92691c7a23a';
        this.redirectUri = 'https://pomodorifi.es';
        this.scope = 'user-read-private user-read-email playlist-read-private playlist-modify-private';
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiry = null;

        this.initializeApp();
    }

    initializeApp() {
        this.loadTokensFromStorage();
        this.setupEventListeners();
        this.handleAuthCallback();
        this.updateUI();
    }

    setupEventListeners() {
        const loginButton = document.getElementById('login-button');
        const generateButton = document.getElementById('generate-button');
        const saveButton = document.getElementById('save-button');
        const regenerateButton = document.getElementById('regenerate-button');
        const createAnotherButton = document.getElementById('create-another-button');

        loginButton?.addEventListener('click', () => this.login());
        generateButton?.addEventListener('click', () => this.generatePlaylist());
        saveButton?.addEventListener('click', () => this.savePlaylist());
        regenerateButton?.addEventListener('click', () => this.generatePlaylist());
        createAnotherButton?.addEventListener('click', () => this.showPlaylistSection());
    }

    loadTokensFromStorage() {
        this.accessToken = localStorage.getItem('spotify_access_token');
        this.refreshToken = localStorage.getItem('spotify_refresh_token');
        const expiry = localStorage.getItem('spotify_token_expiry');
        this.tokenExpiry = expiry ? parseInt(expiry) : null;
    }

    saveTokensToStorage(tokenData) {
        this.accessToken = tokenData.access_token;
        this.refreshToken = tokenData.refresh_token || this.refreshToken;
        this.tokenExpiry = Date.now() + (tokenData.expires_in * 1000);

        localStorage.setItem('spotify_access_token', this.accessToken);
        if (this.refreshToken) {
            localStorage.setItem('spotify_refresh_token', this.refreshToken);
        }
        localStorage.setItem('spotify_token_expiry', this.tokenExpiry.toString());
    }

    async refreshAccessToken() {
        if (!this.refreshToken) return false;

        try {
            const response = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: this.refreshToken,
                    client_id: this.clientId,
                }),
            });

            if (response.ok) {
                const tokenData = await response.json();
                this.saveTokensToStorage(tokenData);
                return true;
            }
        } catch (error) {
            console.error('Failed to refresh token:', error);
        }

        return false;
    }

    async ensureValidToken() {
        if (!this.accessToken) return false;

        // Check if token is expired or will expire soon (within 5 minutes)
        if (this.tokenExpiry && Date.now() > (this.tokenExpiry - 300000)) {
            return await this.refreshAccessToken();
        }

        return true;
    }

    login() {
        const params = new URLSearchParams({
            client_id: this.clientId,
            response_type: 'code',
            redirect_uri: this.redirectUri,
            scope: this.scope,
        });

        window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
    }

    async handleAuthCallback() {
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');

        if (code) {
            try {
                await this.exchangeCodeForToken(code);
                // Remove the code from URL
                window.history.replaceState({}, document.title, window.location.pathname);
                this.updateUI();
                await this.loadPlaylists();
            } catch (error) {
                console.error('Authentication failed:', error);
                alert('Authentication failed. Please try again.');
            }
        }
    }

    async exchangeCodeForToken(code) {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: this.redirectUri,
                client_id: this.clientId,
            }),
        });

        if (!response.ok) {
            throw new Error('Failed to exchange code for token');
        }

        const tokenData = await response.json();
        this.saveTokensToStorage(tokenData);
    }

    async loadPlaylists() {
        if (!(await this.ensureValidToken())) {
            this.showLoginSection();
            return;
        }

        try {
            const response = await fetch('https://api.spotify.com/v1/me/playlists', {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                },
            });

            if (!response.ok) {
                throw new Error('Failed to fetch playlists');
            }

            const data = await response.json();
            this.populatePlaylistSelect(data.items);
        } catch (error) {
            console.error('Failed to load playlists:', error);
            alert('Failed to load playlists. Please try again.');
        }
    }

    populatePlaylistSelect(playlists) {
        const select = document.getElementById('playlist-select');
        select.innerHTML = '';

        playlists.forEach(playlist => {
            const option = document.createElement('option');
            option.value = playlist.id;
            option.textContent = playlist.name;
            select.appendChild(option);
        });
    }

    async generatePlaylist() {
        if (!(await this.ensureValidToken())) {
            this.showLoginSection();
            return;
        }

        const playlistId = document.getElementById('playlist-select').value;
        const duration = parseInt(document.getElementById('duration').value);
        const playlistName = document.getElementById('playlist-name').value;

        if (!playlistId) {
            alert('Please select a playlist.');
            return;
        }

        try {
            // Get playlist tracks
            const tracksResponse = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                },
            });

            if (!tracksResponse.ok) {
                throw new Error('Failed to fetch playlist tracks');
            }

            const tracksData = await tracksResponse.json();
            const tracks = tracksData.items
                .filter(item => item.track)
                .map(item => ({
                    uri: item.track.uri,
                    name: item.track.name,
                    artist: item.track.artists[0].name,
                    duration_ms: item.track.duration_ms,
                }));

            // Select tracks for the duration
            const selectedTracks = this.selectTracksForDuration(tracks, duration);
            this.displayPreview(selectedTracks, playlistName);
        } catch (error) {
            console.error('Failed to generate playlist:', error);
            alert('Failed to generate playlist. Please try again.');
        }
    }

    selectTracksForDuration(tracks, durationMinutes) {
        const durationLimit = durationMinutes * 60 * 1000; // Convert to milliseconds
        const shuffledTracks = [...tracks].sort(() => Math.random() - 0.5);
        
        const selectedTracks = [];
        let totalDuration = 0;

        for (const track of shuffledTracks) {
            if (totalDuration + track.duration_ms <= durationLimit) {
                selectedTracks.push(track);
                totalDuration += track.duration_ms;
            } else {
                // Add one more track even if it exceeds the limit
                selectedTracks.push(track);
                totalDuration += track.duration_ms;
                break;
            }
        }

        return selectedTracks;
    }

    displayPreview(tracks, playlistName) {
        const totalDuration = tracks.reduce((sum, track) => sum + track.duration_ms, 0);

        // Update preview info
        document.getElementById('preview-duration').textContent = this.formatDuration(totalDuration);
        document.getElementById('preview-track-count').textContent = tracks.length.toString();

        // Display tracks
        const trackList = document.getElementById('preview-tracks');
        trackList.innerHTML = '';

        tracks.forEach(track => {
            const trackItem = document.createElement('div');
            trackItem.className = 'track-item';
            trackItem.innerHTML = `
                <div class="track-info">
                    <div class="track-name">${track.name}</div>
                    <div class="track-artist">${track.artist}</div>
                </div>
                <div class="track-duration">${this.formatDuration(track.duration_ms)}</div>
            `;
            trackList.appendChild(trackItem);
        });

        // Store tracks for saving
        window.currentPreview = { tracks, totalDuration: totalDuration, playlistName };

        // Show preview section
        this.showPreviewSection();
    }

    async savePlaylist() {
        if (!(await this.ensureValidToken())) {
            this.showLoginSection();
            return;
        }

        const preview = window.currentPreview;
        if (!preview) {
            alert('No playlist to save. Please generate a playlist first.');
            return;
        }

        try {
            // Get current user
            const userResponse = await fetch('https://api.spotify.com/v1/me', {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                },
            });

            if (!userResponse.ok) {
                throw new Error('Failed to get user info');
            }

            const user = await userResponse.json();

            // Create playlist
            const playlistName = preview.playlistName || `Pomodoro Playlist (${this.formatDuration(preview.totalDuration)})`;
            const createResponse = await fetch(`https://api.spotify.com/v1/users/${user.id}/playlists`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: playlistName,
                    public: false,
                }),
            });

            if (!createResponse.ok) {
                throw new Error('Failed to create playlist');
            }

            const newPlaylist = await createResponse.json();

            // Add tracks to playlist
            const addTracksResponse = await fetch(`https://api.spotify.com/v1/playlists/${newPlaylist.id}/tracks`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    uris: preview.tracks.map(track => track.uri),
                }),
            });

            if (!addTracksResponse.ok) {
                throw new Error('Failed to add tracks to playlist');
            }

            // Show success
            this.showResultSection(newPlaylist.external_urls.spotify);
        } catch (error) {
            console.error('Failed to save playlist:', error);
            alert('Failed to save playlist. Please try again.');
        }
    }

    formatDuration(ms) {
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    updateUI() {
        if (this.accessToken) {
            this.showPlaylistSection();
        } else {
            this.showLoginSection();
        }
    }

    showLoginSection() {
        document.getElementById('login-section').style.display = 'block';
        document.getElementById('playlist-section').style.display = 'none';
        document.getElementById('preview-section').style.display = 'none';
        document.getElementById('result-section').style.display = 'none';
    }

    showPlaylistSection() {
        document.getElementById('login-section').style.display = 'none';
        document.getElementById('playlist-section').style.display = 'block';
        document.getElementById('preview-section').style.display = 'none';
        document.getElementById('result-section').style.display = 'none';
    }

    showPreviewSection() {
        document.getElementById('login-section').style.display = 'none';
        document.getElementById('playlist-section').style.display = 'none';
        document.getElementById('preview-section').style.display = 'block';
        document.getElementById('result-section').style.display = 'none';
    }

    showResultSection(playlistUrl) {
        document.getElementById('login-section').style.display = 'none';
        document.getElementById('playlist-section').style.display = 'none';
        document.getElementById('preview-section').style.display = 'none';
        document.getElementById('result-section').style.display = 'block';

        const playlistLink = document.getElementById('playlist-link');
        playlistLink.href = playlistUrl;
    }
}

// Initialize the app when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new PomodorifyApp();
});
