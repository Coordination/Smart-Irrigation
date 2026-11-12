const express = require('express');
const mongoose = require('mongoose');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 1. MONGODB CONNECTION & SCHEMAS
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
    console.error('ERROR: MONGODB_URI environment variable is missing!');
    process.exit(1);
}

mongoose.connect(MONGODB_URI)
    .then(() => {
        console.log('Connected to MongoDB Atlas');
        seedDefaultData();
    })
    .catch(err => console.error('MongoDB Connection Error:', err));

const plantSchema = new mongoose.Schema({
    plant_name: { type: String, required: true, unique: true },
    required_humidity: { type: Number, required: true }
});

const zoneSchema = new mongoose.Schema({
    zone_id: { type: Number, required: true, unique: true },
    plant_name: { type: String, required: true },
    pump_status: { type: String, default: 'INACTIVE' },
    humidity_level: { type: Number, default: 40.0 },
    cached_img: { type: String, default: '' }
});

const Plant = mongoose.model('Plant', plantSchema);
const Zone = mongoose.model('Zone', zoneSchema);

async function seedDefaultData() {
    try {
        if (await Plant.countDocuments() === 0) {
            await Plant.insertMany([
                { plant_name: 'Tomato', required_humidity: 45.0 },
                { plant_name: 'Fern', required_humidity: 60.0 },
                { plant_name: 'Cactus', required_humidity: 15.0 },
                { plant_name: 'Rose', required_humidity: 40.0 },
                { plant_name: 'Basil', required_humidity: 50.0 }
            ]);
            console.log('Default plant library seeded.');
        }
        if (await Zone.countDocuments() === 0) {
            await Zone.insertMany([
                { zone_id: 0, plant_name: 'Tomato', pump_status: 'INACTIVE', humidity_level: 42.0, cached_img: '' },
                { zone_id: 1, plant_name: 'Fern', pump_status: 'INACTIVE', humidity_level: 58.0, cached_img: '' },
                { zone_id: 2, plant_name: 'Cactus', pump_status: 'INACTIVE', humidity_level: 18.0, cached_img: '' }
            ]);
            console.log('Default zones seeded.');
        }
    } catch (err) {
        console.error('Seed error:', err);
    }
}

// 2. GEMINI AI PLANT LOOKUP & VISION HELPER
async function getOrFetchPlantData(plantName, base64Image = null) {
    const cleanName = plantName ? plantName.trim() : '';
    if (cleanName && !base64Image) {
        const existing = await Plant.findOne({ plant_name: { $regex: new RegExp(`^${cleanName}$`, 'i') } });
        if (existing) return existing;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is missing in environment variables.');

    const parts = [];
    if (base64Image) {
        const base64Clean = base64Image.split(',')[1];
        parts.push({ text: 'Identify the plant in this photo and determine its ideal soil moisture percentage (between 10 and 85). Reply ONLY with valid JSON: {"plant_name": "Common Name", "required_humidity": 45}. If no plant is visible, reply {"plant_name": "Unknown", "required_humidity": 0}.' });
        parts.push({ inline_data: { mime_type: 'image/jpeg', data: base64Clean } });
    } else {
        parts.push({ text: `What is the ideal soil moisture percentage (between 10 and 85) for growing "${cleanName}"? Reply ONLY with valid JSON: {"plant_name": "${cleanName}", "required_humidity": 45}.` });
    }

        const response = await fetch(
        `https://googleapis.com{apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: { responseMimeType: 'application/json' }
            })
        }
    );

    const data = await response.json();
    if (!response.ok || data.error) {
        console.error('Gemini API Error:', data.error || data);
        throw new Error(data.error?.message || 'Gemini API request failed');
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('No response from AI service.');

    const parsed = JSON.parse(rawText);
    if (!parsed.plant_name || parsed.plant_name.toLowerCase() === 'unknown') return null;

    const formattedName = parsed.plant_name.charAt(0).toUpperCase() + parsed.plant_name.slice(1);
    const humidity = parseFloat(parsed.required_humidity) || 45.0;

    let libraryEntry = await Plant.findOne({ plant_name: { $regex: new RegExp(`^${formattedName}$`, 'i') } });
    if (!libraryEntry) {
        libraryEntry = await Plant.create({ plant_name: formattedName, required_humidity: humidity });
    }
    return libraryEntry;
}

// 3. SIMULATED LIVE SENSOR UPDATES (EVERY 5s)
setInterval(async () => {
    try {
        const zones = await Zone.find();
        const plants = await Plant.find();
        for (const z of zones) {
            const newHumidity = parseFloat((Math.random() * (80 - 20) + 20).toFixed(1));
            const targetCrop = plants.find(p => p.plant_name.toLowerCase() === z.plant_name.toLowerCase());
            const newStatus = (targetCrop && newHumidity < targetCrop.required_humidity) ? 'ACTIVE' : 'INACTIVE';
            await Zone.updateOne({ zone_id: z.zone_id }, { humidity_level: newHumidity, pump_status: newStatus });
        }
    } catch (err) {
        console.error('Sensor update error:', err.message);
    }
}, 5000);

// 4. API ROUTES
app.post('/assign-dropdown', async (req, res) => {
    const { zone_id, plant_name } = req.body;
    if (plant_name) await Zone.updateOne({ zone_id: parseInt(zone_id) }, { plant_name });
    res.json({ success: true });
});

app.post('/api/custom-plant', async (req, res) => {
    const { zone_id, plant_name } = req.body;
    if (!plant_name || !plant_name.trim()) return res.status(400).json({ success: false, error: 'Invalid plant name' });
    try {
        const plantInfo = await getOrFetchPlantData(plant_name);
        if (plantInfo) {
            await Zone.updateOne({ zone_id: parseInt(zone_id) }, { plant_name: plantInfo.plant_name });
            return res.json({ success: true, plant: plantInfo });
        }
        return res.json({ success: false, error: 'Could not find humidity data for that plant.' });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/scan-camera', async (req, res) => {
    const { zone_id, image_data } = req.body;
    if (!image_data) return res.status(400).json({ success: false, error: 'Image missing' });
    try {
        const plantInfo = await getOrFetchPlantData(null, image_data);
        if (plantInfo) {
            await Zone.updateOne({ zone_id: parseInt(zone_id) }, { plant_name: plantInfo.plant_name, cached_img: image_data });
            return res.json({ success: true, matched_crop: plantInfo.plant_name, humidity: plantInfo.required_humidity });
        }
        await Zone.updateOne({ zone_id: parseInt(zone_id) }, { cached_img: image_data });
        return res.json({ success: false, error: 'No recognizable plant detected in frame.' });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
// 5. MAIN DASHBOARD INTERFACE
app.get('/', async (req, res) => {
    try {
        const plantLibrary = await Plant.find().sort({ plant_name: 1 });
        const zoneAssignments = await Zone.find().sort({ zone_id: 1 });

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
                <div class="box" id="media-box-${z.zone_id}">
                    <img id="img-${z.zone_id}" src="${z.cached_img || ''}" style="display:${z.cached_img ? 'block' : 'none'}; width:100%; height:100%; object-fit:cover;">
                    <video id="video-${z.zone_id}" autoplay playsinline style="display:none; width:100%; height:100%; object-fit:cover;"></video>
                    <span id="label-${z.zone_id}" style="display:${z.cached_img ? 'none' : 'block'}; color:#777; font-style:italic; font-size:13px;">Camera Off</span>
                </div>
                <select onchange="handleDropdownUpdate(${z.zone_id}, this.value)">
                    <option value="">-- Select Saved Plant --</option>
                    ${dropdownOptions}
                </select>
                <div style="margin-top: 8px; display: flex; gap: 5px;">
                    <input type="text" id="custom-input-${z.zone_id}" placeholder="Or type any plant (e.g. Orchid)" style="flex:2; padding:8px; border:1px solid #ccc; border-radius:4px; font-size:13px;">
                    <button type="button" id="custom-btn-${z.zone_id}" onclick="handleCustomPlant(${z.zone_id})" style="flex:1; background:#2980b9;">Set</button>
                </div>
                <div style="margin-top: 8px; display: flex; gap: 5px;">
                    <button type="button" onclick="startLaptopCamera(${z.zone_id})" style="background:#34495e;">Start Cam</button>
                    <button type="button" id="scan-btn-${z.zone_id}" onclick="captureLaptopFrame(${z.zone_id})" style="background:#27ae60;">Scan Crop</button>
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
            button:disabled{opacity:0.6;cursor:not-allowed;}
        </style>
        <script>
            let operationalStreams = {};
            let isBusy = false;

            async function startLaptopCamera(zoneId) {
                Object.keys(operationalStreams).forEach(id => {
                    operationalStreams[id].getTracks().forEach(track => track.stop());
                    delete operationalStreams[id];
                });

                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    return alert("Camera unavailable: You must open this page via http://localhost:3000 or HTTPS.");
                }

                const video = document.getElementById('video-' + zoneId);
                const img = document.getElementById('img-' + zoneId);
                const label = document.getElementById('label-' + zoneId);
                try {
                    let stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                    operationalStreams[zoneId] = stream;
                    video.srcObject = stream;
                    video.style.display = 'block';
                    if (img) img.style.display = 'none';
                    if (label) label.style.display = 'none';
                } catch (err) {
                    alert("Camera initialization rejected (" + err.name + "): " + err.message);
                }
            }

            async function captureLaptopFrame(zoneId) {
                const video = document.getElementById('video-' + zoneId);
                const scanBtn = document.getElementById('scan-btn-' + zoneId);
                if (!operationalStreams[zoneId]) return alert("Please click 'Start Cam' first!");

                isBusy = true;
                scanBtn.disabled = true;
                scanBtn.innerText = 'Identifying...';

                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth || 640;
                canvas.height = video.videoHeight || 480;
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                const base64Image = canvas.toDataURL('image/jpeg', 0.7);

                operationalStreams[zoneId].getTracks().forEach(track => track.stop());
                delete operationalStreams[zoneId];

                try {
                    const response = await fetch('/api/scan-camera', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ zone_id: zoneId, image_data: base64Image })
                    });
                    const resData = await response.json();
                    if (resData.success) {
                        window.location.reload();
                    } else {
                        alert(resData.error || 'Plant could not be identified.');
                        isBusy = false;
                        scanBtn.disabled = false;
                        scanBtn.innerText = 'Scan Crop';
                    }
                } catch (err) {
                    alert('Network error: ' + err.message);
                    isBusy = false;
                    scanBtn.disabled = false;
                    scanBtn.innerText = 'Scan Crop';
                }
            }

            async function handleCustomPlant(zoneId) {
                const input = document.getElementById('custom-input-' + zoneId);
                const btn = document.getElementById('custom-btn-' + zoneId);
                const plantName = input.value.trim();
                if (!plantName) return alert('Please enter a plant name.');

                isBusy = true;
                btn.disabled = true;
                btn.innerText = '...';

                try {
                    const response = await fetch('/api/custom-plant', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ zone_id: zoneId, plant_name: plantName })
                    });
                    const resData = await response.json();
                    if (resData.success) {
                        window.location.reload();
                    } else {
                        alert(resData.error || 'Could not look up plant.');
                        isBusy = false;
                        btn.disabled = false;
                        btn.innerText = 'Set';
                    }
                } catch (err) {
                    alert('Network error: ' + err.message);
                    isBusy = false;
                    btn.disabled = false;
                    btn.innerText = 'Set';
                }
            }

            async function handleDropdownUpdate(zoneId, plantName) {
                if (!plantName) return;
                isBusy = true;
                await fetch('/assign-dropdown', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'zone_id=' + zoneId + '&plant_name=' + encodeURIComponent(plantName)
                });
                window.location.reload();
            }

            setInterval(() => {
                const activeCamera = Object.keys(operationalStreams).length > 0;
                const isTyping = document.activeElement && document.activeElement.tagName === 'INPUT';
                if (!activeCamera && !isTyping && !isBusy) {
                    window.location.reload();
                }
            }, 6000);
        </script>
        </head><body>
            <h1 style="text-align:center;color:#2e7d32;">Smart Irrigation Control Dashboard</h1>
            <div class="grid">${panelsHtml}</div>
        </body></html>`);
    } catch (err) {
        res.status(500).send('Database error: ' + err.message);
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
