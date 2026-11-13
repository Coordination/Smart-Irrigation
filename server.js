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

const mlModelSchema = new mongoose.Schema({
    model_id: { type: String, default: 'leaf_knn', unique: true },
    dataset_json: { type: String, required: true }
});

const Plant = mongoose.model('Plant', plantSchema);
const Zone = mongoose.model('Zone', zoneSchema);
const MLModel = mongoose.model('MLModel', mlModelSchema);

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

        await Zone.deleteMany({ zone_id: { $ne: 0 } });

        if (await Zone.countDocuments({ zone_id: 0 }) === 0) {
            await Zone.create({
                zone_id: 0,
                plant_name: 'Tomato',
                pump_status: 'INACTIVE',
                humidity_level: 42.0,
                cached_img: ''
            });
            console.log('Single default zone seeded.');
        }
    } catch (err) {
        console.error('Seed error:', err);
    }
}

// 2. GEMINI AI PLANT LOOKUP HELPER
async function getOrFetchPlantData(plantName, base64Image = null) {
    const cleanName = plantName ? plantName.trim() : '';
    if (cleanName && !base64Image) {
        const escapedName = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const existing = await Plant.findOne({ plant_name: { $regex: new RegExp('^' + escapedName + '$', 'i') } });
        if (existing) return existing;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is missing in environment variables.');

    const parts = [];
    if (base64Image) {
        const base64Clean = base64Image.includes(',') ? base64Image.split(',') : base64Image;
        parts.push({ text: 'Identify the plant in this photo and determine its ideal soil moisture percentage (between 10 and 85). Reply ONLY with valid JSON: {"plant_name": "Common Name", "required_humidity": 45}. If no plant is visible, reply {"plant_name": "Unknown", "required_humidity": 0}.' });
        parts.push({ inline_data: { mime_type: 'image/jpeg', data: base64Clean } });
    } else {
        parts.push({ text: 'What is the ideal soil moisture percentage (between 10 and 85) for growing "' + cleanName + '"? Reply ONLY with valid JSON: {"plant_name": "' + cleanName + '", "required_humidity": 45}.' });
    }

    const host = ['generativelanguage', 'googleapis', 'com'].join('.');
    const modelsToTry = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
    let data = null;
    let lastError = 'Gemini API request failed';

    for (const modelName of modelsToTry) {
        const path = ['v1beta', 'models', modelName + ':generateContent'].join('/');
        const geminiUrl = 'https://' + host + '/' + path + '?key=' + apiKey.trim();

        let response;
        try {
            response = await fetch(geminiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(12000),
                body: JSON.stringify({
                    contents: [{ parts }],
                    generationConfig: { responseMimeType: 'application/json' }
                })
            });
        } catch (fetchErr) {
            lastError = fetchErr.name === 'TimeoutError' ? 'AI request timed out' : fetchErr.message;
            continue;
        }

        data = await response.json();
        if (response.ok && !data.error) {
            lastError = null;
            break;
        }
        lastError = data.error?.message || 'Gemini API request failed';
        console.warn('Model ' + modelName + ' busy, trying next...', lastError);
        await new Promise(resolve => setTimeout(resolve, 1500));
    }

    if (lastError) throw new Error(lastError);

    const rawText = data.candidates?.?.content?.parts?.?.text;
    if (!rawText) throw new Error('No response from AI service.');

    const parsed = JSON.parse(rawText);
    if (!parsed.plant_name || parsed.plant_name.toLowerCase() === 'unknown') return null;

    const formattedName = parsed.plant_name.charAt(0).toUpperCase() + parsed.plant_name.slice(1);
    const humidity = parseFloat(parsed.required_humidity) || 45.0;

    let libraryEntry = await Plant.findOne({ plant_name: { $regex: new RegExp('^' + formattedName + '$', 'i') } });
    if (!libraryEntry) {
        libraryEntry = await Plant.create({ plant_name: formattedName, required_humidity: humidity });
    }
    return libraryEntry;
}

// 3. SIMULATED LIVE SENSOR UPDATES (EVERY 5s)
setInterval(async () => {
    try {
        const z = await Zone.findOne({ zone_id: 0 });
        if (!z) return;
        const targetCrop = await Plant.findOne({ plant_name: { $regex: new RegExp('^' + z.plant_name + '$', 'i') } });
        const newHumidity = parseFloat((Math.random() * (80 - 20) + 20).toFixed(1));
        const newStatus = (targetCrop && newHumidity < targetCrop.required_humidity) ? 'ACTIVE' : 'INACTIVE';
        await Zone.updateOne({ zone_id: 0 }, { humidity_level: newHumidity, pump_status: newStatus });
    } catch (err) {
        console.error('Sensor update error:', err.message);
    }
}, 5000);

// 4. API ROUTES
app.post('/assign-dropdown', async (req, res) => {
    const { zone_id, plant_name } = req.body;
    if (plant_name) {
        await Zone.updateOne({ zone_id: parseInt(zone_id) }, { plant_name, cached_img: '' });
    }
    res.json({ success: true });
});

app.post('/api/custom-plant', async (req, res) => {
    const { zone_id, plant_name } = req.body;
    if (!plant_name || !plant_name.trim()) return res.status(400).json({ success: false, error: 'Invalid plant name' });
    try {
        const plantInfo = await getOrFetchPlantData(plant_name);
        if (plantInfo) {
            await Zone.updateOne({ zone_id: parseInt(zone_id) }, { plant_name: plantInfo.plant_name, cached_img: '' });
            return res.json({ success: true, plant: plantInfo });
        }
        return res.json({ success: false, error: 'Could not find humidity data for that plant.' });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/clear-image', async (req, res) => {
    const { zone_id } = req.body;
    await Zone.updateOne({ zone_id: parseInt(zone_id) }, { cached_img: '' });
    res.json({ success: true });
});

app.get('/api/ml-model', async (req, res) => {
    try {
        const saved = await MLModel.findOne({ model_id: 'leaf_knn' });
        res.json({ success: true, dataset_json: saved ? saved.dataset_json : null });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/ml-model', async (req, res) => {
    try {
        const { dataset_json } = req.body;
        if (!dataset_json) return res.status(400).json({ success: false, error: 'Missing dataset' });
        await MLModel.findOneAndUpdate(
            { model_id: 'leaf_knn' },
            { dataset_json },
            { upsert: true, new: true }
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// 5. MAIN DASHBOARD INTERFACE
app.get('/', async (req, res) => {
    try {
        const plantLibrary = await Plant.find().sort({ plant_name: 1 });
        const z = await Zone.findOne({ zone_id: 0 });
        if (!z) return res.status(500).send('Zone not initialized yet. Refresh in a moment.');

        const dropdownOptions = plantLibrary.map(p =>
            '<option value="' + p.plant_name + '">' + p.plant_name + ' (' + p.required_humidity + '%)</option>'
        ).join('');

        const currentThreshold = plantLibrary.find(p => p.plant_name.toLowerCase() === z.plant_name.toLowerCase())?.required_humidity || 0;
        const badgeText = z.pump_status === 'ACTIVE' ? 'PUMP: ON' : 'PUMP: OFF';
        const imgDisplay = z.cached_img ? 'block' : 'none';
        const labelDisplay = z.cached_img ? 'none' : 'block';

        const panelHtml =
            '<div class="card" id="zone-card-' + z.zone_id + '">' +
                '<h2>Zone 1 <span class="badge ' + z.pump_status + '">' + badgeText + '</span></h2>' +
                '<p>Crop Focus: <b style="color:#2e7d32;">' + z.plant_name + '</b> (Threshold: ' + currentThreshold + '%)</p>' +
                '<p>Moisture Reading: <span class="num">' + z.humidity_level + '%</span></p>' +
                '<div class="box" id="media-box-' + z.zone_id + '">' +
                    '<img id="img-' + z.zone_id + '" src="' + (z.cached_img || '') + '" style="display:' + imgDisplay + '; width:100%; height:100%; object-fit:cover;">' +
                    '<video id="video-' + z.zone_id + '" autoplay playsinline style="display:none; width:100%; height:100%; object-fit:cover;"></video>' +
                    '<span id="label-' + z.zone_id + '" style="display:' + labelDisplay + '; color:#777; font-style:italic; font-size:13px;">Camera Off</span>' +
                '</div>' +
                '<select onchange="handleDropdownUpdate(' + z.zone_id + ', this.value)">' +
                    '<option value="">-- Select Saved Plant --</option>' +
                    dropdownOptions +
                '</select>' +
                '<div style="margin-top: 8px; display: flex; gap: 5px;">' +
                    '<input type="text" id="custom-input-' + z.zone_id + '" placeholder="Or type any plant (e.g. Orchid)" style="flex:2; padding:8px; border:1px solid #ccc; border-radius:4px; font-size:13px;">' +
                    '<button type="button" id="custom-btn-' + z.zone_id + '" onclick="handleCustomPlant(' + z.zone_id + ')" style="flex:1; background:#2980b9;">Set</button>' +
                '</div>' +
                '<div style="margin-top: 8px; display: flex; gap: 5px;">' +
                    '<button type="button" onclick="startLaptopCamera(' + z.zone_id + ')" style="background:#34495e;">Start Cam</button>' +
                    '<button type="button" onclick="trainLeafSample(' + z.zone_id + ')" style="background:#e67e22;">Train Leaf</button>' +
                    '<button type="button" id="scan-btn-' + z.zone_id + '" onclick="classifyLeafML(' + z.zone_id + ')" style="background:#27ae60;">Scan Leaf</button>' +
                    '<button type="button" onclick="clearCameraBox(' + z.zone_id + ')" style="background:#7f8c8d;">Clear</button>' +
                '</div>' +
            '</div>';

        const htmlPage = [
            '<!DOCTYPE html><html><head><title>Irrigation Dashboard</title>',
            '<style>',
            'body{font-family:sans-serif;background:#f0f2f5;padding:20px;}',
            '.container{max-width:420px;margin:0 auto;}',
            '.card{background:white;padding:20px;border-radius:8px;box-shadow:0 2px 5px rgba(0,0,0,0.1);border-top:4px solid #2e7d32;}',
            '.badge{float:right;font-size:12px;padding:4px 10px;border-radius:20px;font-weight:bold;}',
            '.ACTIVE{background:#d4edda;color:#155724;border:1px solid #155724;}',
            '.INACTIVE{background:#e2e3e5;color:#383d41;border:1px solid #ccc;}',
            '.num{font-size:22px;font-weight:bold;color:#004085;}',
            '.box{width:100%;height:180px;background:#e9ecef;margin:12px 0;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:4px;border:1px solid #ccc;}',
            'select,button{width:100%;padding:10px;border-radius:4px;border:1px solid #ccc;font-size:13px;}',
            'button{color:white;border:none;cursor:pointer;font-weight:bold;}',
            'button:disabled{opacity:0.6;cursor:not-allowed;}',
            '</style>',
            '<script>',
            'let operationalStreams = {};',
            'let isBusy = false;',
            'let net;',
            'let classifier;',
            'function injectScript(url) {',
            '    return new Promise((resolve, reject) => {',
            '        const s = document.createElement("script");',
            '        s.src = url;',
            '        s.onload = resolve;',
            '        s.onerror = () => reject(new Error("Failed to load " + url));',
            '        document.head.appendChild(s);',
            '    });',
            '}',
            'async function loadMLModel() {',
            '    const scanBtn = document.getElementById("scan-btn-0");',
            '    if (scanBtn) { scanBtn.disabled = true; scanBtn.innerText = "Loading AI..."; }',
            '    try {',
            '        const cdn = "https://" + "cdn.jsdelivr.net" + "/npm/";',
            '        await injectScript(cdn + "@tensorflow/tfjs@4.17.0/dist/tf.min.js");',
            '        await injectScript(cdn + "@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js");',
            '        await injectScript(cdn + "@tensorflow-models/knn-classifier@1.2.4/dist/knn-classifier.min.js");',
            '        classifier = knnClassifier.create();',
            '        await tf.ready();',
            '        net = await mobilenet.load({ version: 2, alpha: 0.5 });',
            '        const res = await fetch("/api/ml-model");',
            '        const data = await res.json();',
            '        if (data.success && data.dataset_json) {',
            '            const raw = JSON.parse(data.dataset_json);',
            '            const tensorObj = {};',
            '            Object.keys(raw).forEach(key => {',
            '                tensorObj[key] = tf.tensor(raw[key].data, raw[key].shape, "float32");',
            '            });',
            '            classifier.setClassifierDataset(tensorObj);',
            '        }',
            '        if (scanBtn) { scanBtn.disabled = false; scanBtn.innerText = "Scan Leaf"; }',
            '        console.log("MobileNet & KNN ready!");',
            '    } catch (err) {',
            '        console.error("Model Load Error:", err);',
            '        if (scanBtn) scanBtn.innerText = "AI Load Failed";',
            '        alert("AI Model failed to load: " + err.message);',
            '    }',
            '}',
            'window.addEventListener("DOMContentLoaded", loadMLModel);',
            'async function trainLeafSample(zoneId) {',
            '    if (!net || !classifier) return alert("AI Model still loading, wait a moment.");',
            '    const plantLabel = document.getElementById("custom-input-" + zoneId).value.trim();',
            '    if (!plantLabel) return alert("Type the plant name in the text box first to train!");',
            '    const video = document.getElementById("video-" + zoneId);',
            '    if (!operationalStreams[zoneId] || video.readyState < 2) return alert("Click Start Cam first!");',
            '    const activation = net.infer(video, true);',
            '    classifier.addExample(activation, plantLabel);',
            '    activation.dispose();',
            '    const dataset = classifier.getClassifierDataset();',
            '    const serializable = {};',
            '    Object.keys(dataset).forEach(key => {',
            '        serializable[key] = { data: Array.from(dataset[key].dataSync()), shape: dataset[key].shape };',
            '    });',
            '    await fetch("/api/ml-model", {',
            '        method: "POST",',
            '        headers: { "Content-Type": "application/json" },',
            '               body: JSON.stringify({ dataset_json: JSON.stringify(serializable) })',
            '    });',
            '    alert("Saved sample to MongoDB for: " + plantLabel + " (Total classes: " + classifier.getNumClasses() + ")");',
            '}',
            'async function classifyLeafML(zoneId) {',
            '    const video = document.getElementById("video-" + zoneId);',
            '    const img = document.getElementById("img-" + zoneId);',
            '    const scanBtn = document.getElementById("scan-btn-" + zoneId);',
            '    if (!net || !classifier) return alert("AI Model still loading, wait 2 seconds.");',
            '    if (!operationalStreams[zoneId] || video.readyState < 2) return alert("Click Start Cam first!");',
            '    if (classifier.getNumClasses() === 0) {',
            '        return alert("No leaves trained yet! Type a plant name and click Train Leaf 3-5 times first.");',
            '    }',
            '    isBusy = true; scanBtn.disabled = true; scanBtn.innerText = "Scanning...";',
            '    try {',
            '        const activation = net.infer(video, true);',
            '        const result = await classifier.predictClass(activation);',
            '        activation.dispose();',
            '        const predictedPlant = result.label;',
            '        const confidence = (result.confidences[result.label] * 100).toFixed(1);',
            '        const canvas = document.createElement("canvas");',
            '        canvas.width = 320; canvas.height = 240;',
            '        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);',
            '        if (img) { img.src = canvas.toDataURL("image/jpeg", 0.8); img.style.display = "block"; }',
            '        video.style.display = "none";',
            '        operationalStreams[zoneId].getTracks().forEach(track => track.stop());',
            '        delete operationalStreams[zoneId];',
            '        if (parseFloat(confidence) < 60) {',
            '            isBusy = false; scanBtn.disabled = false; scanBtn.innerText = "Scan Leaf";',
            '            return alert("Low confidence (" + confidence + "%). Add more samples with Train Leaf.");',
            '        }',
            '        const response = await fetch("/api/custom-plant", {',
            '            method: "POST",',
            '            headers: { "Content-Type": "application/json" },',
            '            body: JSON.stringify({ zone_id: zoneId, plant_name: predictedPlant })',
            '        });',
            '        const resData = await response.json();',
            '        if (resData.success) window.location.reload();',
            '        else { alert(resData.error); isBusy = false; scanBtn.disabled = false; scanBtn.innerText = "Scan Leaf"; }',
            '    } catch (err) {',
            '        alert("Scan Leaf Error: " + err.message);',
            '        isBusy = false; scanBtn.disabled = false; scanBtn.innerText = "Scan Leaf";',
            '    }',
            '}',
            'async function startLaptopCamera(zoneId) {',
            '    Object.keys(operationalStreams).forEach(id => {',
            '        operationalStreams[id].getTracks().forEach(track => track.stop());',
            '        delete operationalStreams[id];',
            '    });',
            '    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {',
            '        return alert("Camera unavailable: Please open this site over HTTPS.");',
            '    }',
            '    const video = document.getElementById("video-" + zoneId);',
            '    const img = document.getElementById("img-" + zoneId);',
            '    const label = document.getElementById("label-" + zoneId);',
            '    try {',
            '        let stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });',
            '        operationalStreams[zoneId] = stream;',
            '        video.srcObject = stream;',
            '        video.style.display = "block";',
            '        if (img) img.style.display = "none";',
            '        if (label) label.style.display = "none";',
            '    } catch (err) {',
            '        alert("Camera initialization rejected (" + err.name + "): " + err.message);',
            '    }',
            '}',
            'async function handleCustomPlant(zoneId) {',
            '    const input = document.getElementById("custom-input-" + zoneId);',
            '    const btn = document.getElementById("custom-btn-" + zoneId);',
            '    const plantName = input.value.trim();',
            '    if (!plantName) return alert("Please enter a plant name.");',
            '    isBusy = true; btn.disabled = true; btn.innerText = "...";',
            '    try {',
            '        const response = await fetch("/api/custom-plant", {',
            '            method: "POST",',
            '            headers: { "Content-Type": "application/json" },',
            '            body: JSON.stringify({ zone_id: zoneId, plant_name: plantName })',
            '        });',
            '        const resData = await response.json();',
            '        if (resData.success) window.location.reload();',
            '        else { alert(resData.error || "Could not look up plant."); isBusy = false; btn.disabled = false; btn.innerText = "Set"; }',
            '    } catch (err) {',
            '        alert("Network error: " + err.message);',
            '        isBusy = false; btn.disabled = false; btn.innerText = "Set";',
            '    }',
            '}',
            'async function handleDropdownUpdate(zoneId, plantName) {',
            '    if (!plantName) return;',
            '    isBusy = true;',
            '    await fetch("/assign-dropdown", {',
            '        method: "POST",',
            '        headers: { "Content-Type": "application/x-www-form-urlencoded" },',
            '        body: "zone_id=" + zoneId + "&plant_name=" + encodeURIComponent(plantName)',
            '    });',
            '    window.location.reload();',
            '}',
            'async function clearCameraBox(zoneId) {',
            '    isBusy = true;',
            '    if (operationalStreams[zoneId]) {',
            '        operationalStreams[zoneId].getTracks().forEach(track => track.stop());',
            '        delete operationalStreams[zoneId];',
            '    }',
            '    await fetch("/api/clear-image", {',
            '        method: "POST",',
            '        headers: { "Content-Type": "application/json" },',
            '        body: JSON.stringify({ zone_id: zoneId })',
            '    });',
            '    window.location.reload();',
            '}',
            'setInterval(() => {',
            '    const activeCamera = Object.keys(operationalStreams).length > 0;',
            '    const isTyping = document.activeElement && document.activeElement.tagName === "INPUT";',
            '    if (!activeCamera && !isTyping && !isBusy) {',
            '        window.location.reload();',
            '    }',
            '}, 6000);',
            '</script>',
            '</head><body>',
            '<h1 style="text-align:center;color:#2e7d32;">Smart Irrigation Control Dashboard</h1>',
            '<div class="container">' + panelHtml + '</div>',
            '</body></html>'
        ].join('\n');

        res.send(htmlPage);
    } catch (err) {
        res.status(500).send('Database error: ' + err.message);
    }
});

app.listen(PORT, '0.0.0.0', () => console.log('Server running on port ' + PORT));
