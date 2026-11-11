const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Allow the server to receive larger image uploads from the webcam
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// In-Memory Database Data Sets
let plantLibrary = [
    { plant_name: 'Tomato', required_humidity: 45.0 },
    { plant_name: 'Fern', required_humidity: 60.0 },
    { plant_name: 'Cactus', required_humidity: 15.0 },
    { plant_name: 'Rose', required_humidity: 40.0 },
    { plant_name: 'Basil', required_humidity: 50.0 }
];

let zoneAssignments = [
    { zone_id: 0, plant_name: 'Tomato', pump_status: 'INACTIVE', humidity_level: 42.0, cached_img: '' },
    { zone_id: 1, plant_name: 'Fern', pump_status: 'INACTIVE', humidity_level: 58.0, cached_img: '' },
    { zone_id: 2, plant_name: 'Cactus', pump_status: 'INACTIVE', humidity_level: 18.0, cached_img: '' }
];

// Simulated Live Sensor Updates (Runs every 3 seconds)
setInterval(() => {
    zoneAssignments.forEach(z => {
        z.humidity_level = parseFloat((Math.random() * (80 - 20) + 20).toFixed(1));
        const targetCrop = plantLibrary.find(p => p.plant_name.toLowerCase() === z.plant_name.toLowerCase());
        if (targetCrop) {
            z.pump_status = (z.humidity_level < targetCrop.required_humidity) ? 'ACTIVE' : 'INACTIVE';
        }
    });
}, 3000);

// Manual Dropdown Selector Assignment Route
app.post('/assign-dropdown', (req, res) => {
    const { zone_id, plant_name } = req.body;
    const targetZone = zoneAssignments.find(z => z.zone_id === parseInt(zone_id));
    if (targetZone && plant_name) targetZone.plant_name = plant_name;
    res.json({ success: true });
});

// Camera Upload & AI Match Routing
app.post('/api/scan-camera', (express.json()), (req, res) => {
    const { zone_id, image_data } = req.body;
    const targetZone = zoneAssignments.find(z => z.zone_id === parseInt(zone_id));
    
    if (targetZone) {
        // Store the captured Base64 string directly in our virtual database row
        if (image_data) targetZone.cached_img = image_data;
        
        // Simulate AI crop identification
        const randomCrop = plantLibrary[Math.floor(Math.random() * plantLibrary.length)];
        targetZone.plant_name = randomCrop.plant_name;
        
        return res.json({ success: true, matched_crop: randomCrop.plant_name });
    }
    res.status(400).json({ success: false, error: 'Zone not found' });
});

// Main Dashboard Interface
app.get('/', (req, res) => {
    const dropdownOptions = plantLibrary.map(p => 
        `<option value="${p.plant_name}">${p.plant_name} (${p.required_humidity}%)</option>`
    ).join('');

    let panelsHtml = zoneAssignments.map(z => {
        const currentThreshold = plantLibrary.find(p => p.plant_name.toLowerCase() === z.plant_name.toLowerCase())?.required_humidity || 0;
        
        return `
        <div class="card" id="zone-card-${z.zone_id}">
            <h2>Zone ${z.zone_id + 1} <span class="badge ${z.pump_status}">${z.pump_status === 'ACTIVE' ? 'PUMP: ON' : 'PUMP: OFF'}</span></h2>
            <p>Crop Focus: <b style="color:#2e7d32;">${z.plant_name}</b> (Threshold: ${currentThreshold}%)</p>
            <p>Moisture Reading: <span class="num">${z.humidity_level}%</span></p>
            
            <!-- Live Web Video/Capture Container -->
            <div class="box" id="media-box-${z.zone_id}">
                ${z.cached_img ? `<img src="${z.cached_img}" style="width:100%; height:100%; object-fit:cover;">` : `
                    <video id="video-${z.zone_id}" autoplay playsinline style="display:none; width:100%; height:100%; object-fit:cover;"></video>
                    <span id="label-${z.zone_id}" style="color:#777; font-style:italic; font-size:13px;">Camera Off</span>
                `}
            </div>

            <select onchange="handleDropdownUpdate(${z.zone_id}, this.value)">
                <option value="">-- Change Plant Crop --</option>
                ${dropdownOptions}
            </select>

            <div style="margin-top: 8px; display: flex; gap: 5px;">
                <button type="button" onclick="startLaptopCamera(${z.zone_id})" style="background:#34495e;">📹 Start Cam</button>
                <button type="button" onclick="captureLaptopFrame(${z.zone_id})" style="background:#27ae60;">📷 Scan Crop</button>
            </div>
        </div>`;
    }).join('');

    res.send(`<!DOCTYPE html><html><head><title>Irrigation Dashboard</title>
    <style>
        body{font-family:sans-serif;background:#f0f2f5;padding:20px;} 
        .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;max-width:1200px;margin:0 auto;} 
        .card{background:white;padding:20px;border-radius:8px;box-shadow:0 2px 5px rgba(0,0,0,0.1);border-top:4px solid #2e7d32;} 
        .badge{float:right;font-size:12px;padding:4px 10px;border-radius:20px;font-weight:bold;} 
        .ACTIVE{background:#d4edda;color:#155724;border:1px solid #155724;} 
        .INACTIVE{background:#e2e3e5;color:#383d41;border:1px solid #ccc;} 
        .num{font-size:22px;font-weight:bold;color:#004085;} 
        .box{width:100%;height:150px;background:#e9ecef;margin:12px 0;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:4px;border:1px solid #ccc;} 
        select,button{width:100%;padding:10px;border-radius:4px;border:1px solid #ccc;font-size:13px;} 
        button{color:white;border:none;cursor:pointer;font-weight:bold;}
    </style>
    <script>
        let operationalStreams = {};

        // 1. Request laptop camera access straight from the browser
        async function startLaptopCamera(zoneId) {
            const video = document.getElementById('video-' + zoneId);
            const label = document.getElementById('label-' + zoneId);
            try {
                let stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                operationalStreams[zoneId] = stream;
                video.srcObject = stream;
                video.style.display = 'block';
                if(label) label.style.display = 'none';
            } catch (err) {
                alert("Camera initialization rejected: " + err.message);
            }
        }

        // 2. Snap the active canvas frame and POST data back to Render cloud variables
        async function captureLaptopFrame(zoneId) {
            const video = document.getElementById('video-' + zoneId);
            if (!operationalStreams[zoneId]) return alert("Please click 'Start Cam' first!");

            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth || 640;
            canvas.height = video.videoHeight || 480;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            
            const base64Image = canvas.toDataURL('image/jpeg');

            // Turn off camera stream after capturing
            if (operationalStreams[zoneId]) {
                operationalStreams[zoneId].getTracks().forEach(track => track.stop());
            }

            const response = await fetch('/api/scan-camera', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ zone_id: zoneId, image_data: base64Image })
            });
            const resData = await response.json();
            if(resData.success) {
                window.location.reload();
            }
        }

        async function handleDropdownUpdate(zoneId, plantName) {
            if(!plantName) return;
            await fetch('/assign-dropdown', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'zone_id=' + zoneId + '&plant_name=' + encodeURIComponent(plantName)
            });
            window.location.reload();
        }

        // Keep telemetry fresh by auto-refreshing the dashboard data frame values every 5 seconds
        setInterval(() => {
            // Only auto-refresh if the user isn't currently using their webcam
            if (Object.keys(operationalStreams).length === 0) {
                window.location.reload();
            }
        }, 5000);
    </script>
    </head><body><h2 style="text-align:center;color:#2c3e50;margin-bottom:25px;">🌿 AI Smart Irrigation Management Hub</h2><div class="grid">${panelsHtml}</div></body></html>`);
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server globally executing live on port ${PORT}`));
