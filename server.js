const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const NodeWebcam = require('node-webcam');

const app = express();
const PORT = 3000;
const DB_FILE = path.join(__dirname, 'irrigation.db');

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) return console.error(err.message);
    console.log('Connected to Offline Simulation DB.');
});

const Webcam = NodeWebcam.create({ width: 640, height: 480, quality: 100, output: "jpeg", callbackReturn: "location", verbose: false });
const imgDir = path.join(__dirname, 'public', 'snapshots');
if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS plant_library (plant_name TEXT PRIMARY KEY COLLATE NOCASE, required_humidity REAL)`);
    db.run(`CREATE TABLE IF NOT EXISTS zone_assignments (zone_id INTEGER PRIMARY KEY, plant_name TEXT, pump_status TEXT DEFAULT 'INACTIVE')`);
    db.run(`CREATE TABLE IF NOT EXISTS multi_humidity_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, zone_id INTEGER, humidity_level REAL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);

    const samples = [['Tomato', 45.0], ['Fern', 60.0], ['Cactus', 15.0], ['Rose', 40.0], ['Basil', 50.0]];
    samples.forEach(([n, h]) => db.run("INSERT OR IGNORE INTO plant_library VALUES (?, ?)", [n, h]));
    
    [0, 1, 2].forEach(id => {
        db.run("INSERT OR IGNORE INTO zone_assignments (zone_id, plant_name) VALUES (?, ?)", [id, samples[id][0]]);
    });
});

// Automated Sensor Simulation (Runs every 3 seconds)
setInterval(() => {
    [0, 1, 2].forEach(zoneId => {
        const currentHumidity = parseFloat((Math.random() * (80 - 20) + 20).toFixed(1));
        db.run(`INSERT INTO multi_humidity_logs (zone_id, humidity_level) VALUES (?, ?)`, [zoneId, currentHumidity]);

        db.get(`SELECT z.plant_name, l.required_humidity FROM zone_assignments z 
                LEFT JOIN plant_library l ON z.plant_name = l.plant_name WHERE z.zone_id = ?`, [zoneId], (err, row) => {
            if (!row || !row.required_humidity) return;
            let finalStatus = (currentHumidity < row.required_humidity) ? 'ACTIVE' : 'INACTIVE';
            db.run(`UPDATE zone_assignments SET pump_status = ? WHERE zone_id = ?`, [finalStatus, zoneId]);
        });
    });
}, 3000);

app.post('/assign-dropdown', (req, res) => {
    db.run("UPDATE zone_assignments SET plant_name = ? WHERE zone_id = ?", [req.body.plant_name, parseInt(req.body.zone_id)], () => res.redirect('/'));
});

app.post('/scan-camera', (req, res) => {
    const zone_id = parseInt(req.body.zone_id);
    Webcam.capture(path.join(imgDir, `zone_${zone_id}_scan`), () => {
        db.all("SELECT plant_name FROM plant_library", [], (err, rows) => {
            if (!rows || rows.length === 0) return res.redirect('/');
            const p = rows[Math.floor(Math.random() * rows.length)].plant_name;
            db.run("UPDATE zone_assignments SET plant_name = ? WHERE zone_id = ?", [p, zone_id], () => res.redirect('/'));
        });
    });
});

app.get('/', (req, res) => {
    db.all(`SELECT * FROM plant_library`, [], (err, lib) => {
        db.all(`SELECT z.*, l.required_humidity FROM zone_assignments z LEFT JOIN plant_library l ON z.plant_name = l.plant_name`, [], (err, zones) => {
            db.all(`SELECT m.* FROM multi_humidity_logs m INNER JOIN (SELECT zone_id, MAX(timestamp) as ts FROM multi_humidity_logs GROUP BY zone_id) sys ON m.zone_id = sys.zone_id AND m.timestamp = sys.ts`, [], (err, logs) => {
                const live = {}; 
                logs?.forEach(r => { live[r.zone_id] = r.humidity_level; });
                const opts = lib ? lib.map(p => `<option value="${p.plant_name}">${p.plant_name} (${p.required_humidity}%)</option>`).join('') : '';
                
                let panels = zones ? zones.map(z => {
                    const val = live[z.zone_id] !== undefined ? `${live[z.zone_id]}%` : 'Reading...';
                    const localImgPath = path.join(imgDir, `zone_${z.zone_id}_scan.jpg`);
                    const imgUrl = fs.existsSync(localImgPath) ? `/snapshots/zone_${z.zone_id}_scan.jpg?t=${Date.now()}` : '';
                    
                    return `
                    <div class="card">
                        <h2>Zone ${z.zone_id + 1} <span class="badge ${z.pump_status}">${z.pump_status === 'ACTIVE' ? 'PUMP: ON' : 'PUMP: OFF'}</span></h2>
                        <p>Crop Focus: <b style="color:#2e7d32;">${z.plant_name || 'None'}</b> (Threshold: ${z.required_humidity || 0}%)</p>
                        <p>Moisture Reading: <span class="num">${val}</span></p>
                        <div class="box">${imgUrl ? `<img src="${imgUrl}" class="img">` : '<span style="color:#777; font-style:italic; font-size:13px;">No Camera Scan Cached</span>'}</div>
                        <form action="/assign-dropdown" method="POST">
                            <input type="hidden" name="zone_id" value="${z.zone_id}">
                            <select name="plant_name" onchange="this.form.submit()">
                                <option value="">-- Change Plant Crop --</option>
                                ${opts}
                            </select>
                        </form>
                        <form action="/scan-camera" method="POST" style="margin-top:8px;">
                            <input type="hidden" name="zone_id" value="${z.zone_id}">
                            <button type="submit">📷 Trigger AI Camera Scan</button>
                        </form>
                    </div>`;
                }).join('') : '';
                
                res.send(`<!DOCTYPE html><html><head><title>Irrigation Dashboard</title><meta http-equiv="refresh" content="3"><style>body{font-family:sans-serif;background:#f0f2f5;padding:20px;} .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;max-width:1200px;margin:0 auto;} .card{background:white;padding:20px;border-radius:8px;box-shadow:0 2px 5px rgba(0,0,0,0.1);border-top:4px solid #2e7d32;} .badge{float:right;font-size:12px;padding:4px 10px;border-radius:20px;font-weight:bold;} .ACTIVE{background:#d4edda;color:#155724;border:1px solid #155724;} .INACTIVE{background:#e2e3e5;color:#383d41;border:1px solid #ccc;} .num{font-size:22px;font-weight:bold;color:#004085;} .box{width:100%;height:140px;background:#e9ecef;margin:12px 0;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:4px;} .img{width:100%;height:100%;object-fit:cover;} select,button{width:100%;padding:10px;border-radius:4px;border:1px solid #ccc;font-size:13px;} button{background:#007bff;color:white;border:none;cursor:pointer;font-weight:bold;}</style></head><body><h2 style="text-align:center;color:#2c3e50;margin-bottom:25px;">🌿 AI Smart Irrigation Management Hub (Simulated)</h2><div class="grid">${panels}</div></body></html>`);
            });
        });
    });
});

const PORT_ENV = process.env.PORT || 3000;
app.listen(PORT_ENV, '0.0.0.0', () => console.log(`Cloud Server Active on port ${PORT_ENV}`));

