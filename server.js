const express = require('express');
const mongoose = require('mongoose');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ==========================================
// 1. MONGODB CONNECTION & SCHEMAS
// ==========================================
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
        const plantCount = await Plant.countDocuments();
        if (plantCount === 0) {
            await Plant.insertMany([
                { plant_name: 'Tomato', required_humidity: 45.0 },
                { plant_name: 'Fern', required_humidity: 60.0 },
                { plant_name: 'Cactus', required_humidity: 15.0 },
                { plant_name: 'Rose', required_humidity: 40.0 },
                { plant_name: 'Basil', required_humidity: 50.0 }
            ]);
            console.log('Default plant library seeded to MongoDB.');
        }

        const zoneCount = await Zone.countDocuments();
        if (zoneCount === 0) {
            await Zone.insertMany([
                { zone_id: 0, plant_name: 'Tomato', pump_status: 'INACTIVE', humidity_level: 42.0, cached_img: '' },
                { zone_id: 1, plant_name: 'Fern', pump_status: 'INACTIVE', humidity_level: 58.0, cached_img: '' },
                { zone_id: 2, plant_name: 'Cactus', pump_status: 'INACTIVE', humidity_level: 18.0, cached_img: '' }
            ]);
            console.log('Default zones seeded to MongoDB.');
        }
    } catch (err) {
        console.error('Seed error:', err);
    }
}

// ==========================================
// 2. GEMINI AI PLANT LOOKUP & VISION HELPER
// ==========================================
async function getOrFetchPlantData(plantName, base64Image = null) {
    const cleanName = plantName ? plantName.trim() : '';

    if (cleanName && !base64Image) {
        const existing = await Plant.findOne({
            plant_name: { $regex: new RegExp(`^${cleanName}$`, 'i') }
        });
        if (existing) return existing;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY is missing in environment variables.');
    }

    const parts = [];
    if (base64Image) {
        const base64Clean = base64Image.split(',')[1];
        parts.push({
            text: 'Identify the plant in this photo and determine its ideal soil moisture percentage (between 10 and 85). Reply ONLY with valid JSON in this exact format: {"plant_name": "Common Name", "required_humidity": 45}. If no plant is visible, reply {"plant_name": "Unknown", "required_humidity": 0}.'
        });
        parts.push({
            inline_data: { mime_type: 'image/jpeg', data: base64Clean }
        });
    } else {
        parts.push({
            text: `What is the ideal soil moisture percentage (between 10 and 85) for growing "${cleanName}"? Reply ONLY with valid JSON in this exact format: {"plant_name": "${cleanName}", "required_humidity": 45}.`
        });
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
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('No response from AI service.');

    const parsed = JSON.parse(rawText);
    if (!parsed.plant_name || parsed.plant_name.toLowerCase() === 'unknown') {
        return null;
    }

    const formattedName = parsed.plant_name.charAt(0).toUpperCase() + parsed.plant_name.slice(1);
    const humidity = parseFloat(parsed.required_humidity) || 45.0;

    let libraryEntry = await Plant.findOne({
        plant_name: { $regex: new RegExp(`^${formattedName}$`, 'i') }
    });

    if (!libraryEntry) {
        libraryEntry = await Plant.create({
            plant_name: formattedName,
            required_humidity: humidity
        });
    }

    return libraryEntry;
}

// ==========================================
// 3. SIMULATED LIVE SENSOR UPDATES (EVERY 5s)
// ==========================================
setInterval(async () => {
    try {
        const zones = await Zone.find();
        const plants = await Plant.find();

        for (const z of zones) {
            const newHumidity = parseFloat((Math.random() * (80 - 20) + 20).toFixed(1));
            const targetCrop = plants.find(p => p.plant_name.toLowerCase() === z.plant_name.toLowerCase());
            const newStatus = (targetCrop && newHumidity < targetCrop.required_humidity) ? 'ACTIVE' : 'INACTIVE';

            await Zone.updateOne(
                { zone_id: z.zone_id },
                { humidity_level: newHumidity, pump_status: newStatus }
            );
        }
    } catch (err) {
        console.error('Sensor update error:', err.message);
    }
}, 5000);

// ==========================================
// 4. API ROUTES
// ==========================================
app.post('/assign-dropdown', async (req, res) => {
    const { zone_id, plant_name } = req.body;
    if (plant_name) {
        await Zone.updateOne({ zone_id: parseInt(zone_id) }, { plant_name });
    }
    res.json({ success: true });
});

app.post('/api/custom-plant', async (req, res) => {
    const { zone_id, plant_name } = req.body;
    if (!plant_name || !plant_name.trim()) {
        return res.status(400).json({ success: false, error: 'Invalid plant name' });
    }

    try {
        const plantInfo = await getOrFetchPlantData(plant_name);
        if (plantInfo) {
            await Zone.updateOne(
                { zone_id: parseInt(zone_id) },
                { plant_name: plantInfo.plant_name }
            );
            return res.json({ success: true, plant: plantInfo });
        }
        return res.json({ success: false, error: 'Could not find humidity data for that plant.' });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/scan-camera', async (req, res) => {
    const { zone_id, image_data } = req.body;
    if (!image_data) {
        return res.status(400).json({ success: false, error: 'Image missing' });
    }

    try {
        const plantInfo = await getOrFetchPlantData(null, image_data);
        if (plantInfo) {
            await Zone.updateOne(
                { zone_id: parseInt(zone_id) },
                { plant_name: plantInfo.plant_name, cached_img: image_data }
            );
            return res.json({
                success: true,
                matched_crop: plantInfo.plant_name,
                humidity: plantInfo.required_humidity
            });
        }
        await Zone.updateOne({ zone_id: parseInt(zone_id) }, { cached_img: image_data });
        return res.json({ success: false, error: 'No recognizable plant detected in frame.' });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 5. MAIN DASHBOARD INTERFACE
// ==========================================
app.get('/', async (req, res) => {
    try {
        const plantLibrary = await Plant.find().sort({ plant_name: 1 });
        const zoneAssignments = await Zone.find().sort({ zone_id: 1 });

        const dropdownOptions = plantLibrary.map(p =>
            `<option value="${p.plant_name}">${p.plant_name} (${p.required_humidity}%)</option>`
        ).join('');

        let panelsHtml = zoneAssignments.map(z => {
            const currentThreshold = plantLibrary.find(
                p => p.plant_name.toLowerCase() === z.plant_name.toLowerCase()
            )?.required_humidity || 0;

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

