// GTag Mod Backend — updater + admin dashboard + room command API
const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const Redis = require("ioredis");

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_KEY = process.env.UPLOAD_KEY || "change-me-please";
const ALLOW_CODE_ADMINS = String(process.env.ALLOW_CODE_ADMINS || "true").toLowerCase() === "true";
const REDIS_URL = process.env.REDIS_URL;
const redis = REDIS_URL ? new Redis(REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: true }) : null;
if (redis) redis.on("error", e => console.error("Redis error:", e.message));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GH_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents`;
const GH_RAW = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}`;

function ghHeaders() {
  return { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "gtag-mod-backend" };
}
async function ghGetSha(filePath) {
  const r = await fetch(`${GH_API}/${filePath}?ref=${GITHUB_BRANCH}`, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub GET ${filePath} failed: ${r.status}`);
  return (await r.json()).sha;
}
async function ghPutFile(filePath, buffer, message) {
  const sha = await ghGetSha(filePath);
  const body = { message, content: buffer.toString("base64"), branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(`${GH_API}/${filePath}`, { method: "PUT", headers: { ...ghHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`GitHub PUT ${filePath} failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function ghGetJson(filePath, fallback) {
  const r = await fetch(`${GH_RAW}/${filePath}?t=${Date.now()}`);
  if (r.status === 404) return fallback;
  if (!r.ok) throw new Error(`GitHub raw GET ${filePath} failed: ${r.status}`);
  return r.json();
}
async function ghPutJson(filePath, value, message) {
  return ghPutFile(filePath, Buffer.from(JSON.stringify(value, null, 2)), message);
}
function sameId(a, b) { return String(a || "").trim().toUpperCase() === String(b || "").trim().toUpperCase(); }

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ----- updater -----
app.get("/version", async (req, res) => { try { const m = await ghGetJson("meta.json", { version:"0.0.0", filename:"", hash:"" }); res.json({ version:m.version, hash:m.hash, filename:m.filename }); } catch(e){res.status(500).json({error:e.message});} });
app.get("/download", async (req, res) => { try { const m=await ghGetJson("meta.json",null); if(!m||!m.filename)return res.status(404).send("No file uploaded yet"); res.redirect(`${GH_RAW}/${m.filename}`); } catch(e){res.status(500).json({error:e.message});} });
app.post("/upload", upload.single("modfile"), async (req,res)=>{try{
  const {key,version}=req.body;
  if(key!==UPLOAD_KEY)return res.status(403).json({error:"Wrong upload key"});
  if(!req.file||!version)return res.status(400).json({error:"Missing file or version"});
  const storedName="current"+(path.extname(req.file.originalname)||".dll");
  await ghPutFile(storedName,req.file.buffer,`Upload v${version}`);
  const hash=crypto.createHash("sha256").update(req.file.buffer).digest("hex");
  const old=await ghGetJson("meta.json",{history:[]});
  const history=[...(old.version?[{version:old.version,filename:old.filename,replacedAt:new Date().toISOString()}]:[]),...(old.history||[])].slice(0,20);
  await ghPutJson("meta.json",{version,filename:storedName,originalName:req.file.originalname,hash,uploadedAt:new Date().toISOString(),history},`Update meta for v${version}`);
  res.json({ok:true,version,hash});
}catch(e){res.status(500).json({error:e.message});}});
app.get("/history",async(req,res)=>{try{const m=await ghGetJson("meta.json",{version:"0.0.0",history:[]});res.json({current:m.version,uploadedAt:m.uploadedAt,history:m.history||[]});}catch(e){res.status(500).json({error:e.message});}});

// ----- admins -----
app.get("/admins",async(req,res)=>{try{res.json({admins:await ghGetJson("admins.json",[]),allowCodeAdmins:ALLOW_CODE_ADMINS});}catch(e){res.status(500).json({error:e.message});}});
app.post("/admins/add",async(req,res)=>{try{const {key,userId}=req.body;if(key!==UPLOAD_KEY)return res.status(403).json({error:"Wrong upload key"});const id=String(userId||"").trim();if(!id)return res.status(400).json({error:"Missing Photon UserId"});const a=await ghGetJson("admins.json",[]);if(!a.some(x=>sameId(x,id)))a.push(id);await ghPutJson("admins.json",a,`Add admin ${id}`);res.json({ok:true,admins:a});}catch(e){res.status(500).json({error:e.message});}});
app.post("/admins/remove",async(req,res)=>{try{const {key,userId}=req.body;if(key!==UPLOAD_KEY)return res.status(403).json({error:"Wrong upload key"});const id=String(userId||"").trim();const a=(await ghGetJson("admins.json",[])).filter(x=>!sameId(x,id));await ghPutJson("admins.json",a,`Remove admin ${id}`);res.json({ok:true,admins:a});}catch(e){res.status(500).json({error:e.message});}});

// ----- bans -----
async function saveBan(id){const bans=await ghGetJson("bans.json",[]);if(!bans.some(x=>sameId(x,id))){bans.push(String(id).trim());await ghPutJson("bans.json",bans,`Ban player ${id}`);}}
app.get("/bans",async(req,res)=>{try{if(req.get("X-Upload-Key")!==UPLOAD_KEY&&req.query.key!==UPLOAD_KEY)return res.status(403).json({error:"Wrong upload key"});res.json({bans:await ghGetJson("bans.json",[])});}catch(e){res.status(500).json({error:e.message});}});
app.post("/bans/remove",async(req,res)=>{try{const {key,userId}=req.body;if(key!==UPLOAD_KEY)return res.status(403).json({error:"Wrong upload key"});const id=String(userId||"").trim();const bans=(await ghGetJson("bans.json",[])).filter(x=>!sameId(x,id));await ghPutJson("bans.json",bans,`Unban player ${id}`);res.json({ok:true,bans});}catch(e){res.status(500).json({error:e.message});}});
app.get("/admin/ban/:playerId",async(req,res)=>{try{const bans=await ghGetJson("bans.json",[]);res.json({banned:bans.some(x=>sameId(x,req.params.playerId))});}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/ban",async(req,res)=>{try{const id=String(req.body.playerId||"").trim();if(!id)return res.status(400).json({error:"No playerId"});await saveBan(id);res.json({success:true,banned:await ghGetJson("bans.json",[])});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/check-ban/:playerId",async(req,res)=>{try{const bans=await ghGetJson("bans.json",[]);res.json({banned:bans.some(x=>sameId(x,req.params.playerId))});}catch(e){res.status(500).json({error:e.message});}});

// ----- durable room commands (Render Key Value / Valkey) -----
const COMMAND_KEEP = 500;
const COMMAND_TTL_SECONDS = 600;
const ALLOWED_ACTIONS = ["kick","ban","freeze","teleport","notify","mute","deafen","mute_admins","deafen_admins"];

async function isDashboardAdmin(id){const a=await ghGetJson("admins.json",[]);return a.some(x=>sameId(x,id));}

function commandKey(room){
  return `gtag:commands:${crypto.createHash("sha256").update(String(room)).digest("hex").slice(0,32)}`;
}

async function enqueueCommand(c){
  if(!redis) throw new Error("REDIS_URL is not configured");
  const id=await redis.incr("gtag:nextCommandId");
  c.id=Number(id);
  const key=commandKey(c.room);
  await redis.zadd(key,c.id,JSON.stringify(c));
  await redis.zremrangebyrank(key,0,-(COMMAND_KEEP+1));
  await redis.expire(key,COMMAND_TTL_SECONDS);
  return c.id;
}

app.post("/admin/command",async(req,res)=>{try{
  const {adminId,codeAdmin,targetId,room,action,freeze,x,y,z,message}=req.body;
  if(!adminId||!room||!targetId)return res.status(400).json({error:"Missing adminId, room, or targetId"});
  const dashboardAdmin=await isDashboardAdmin(adminId);
  // Code-admin mode is intentionally supported for this client-controlled minigame.
  // It is not a tamper-proof server boundary because a modified DLL can forge client claims.
  if(!dashboardAdmin&&!(ALLOW_CODE_ADMINS&&codeAdmin===true))return res.status(403).json({error:"Admin verification failed"});
  if(!ALLOWED_ACTIONS.includes(action))return res.status(400).json({error:"Invalid action"});

  // BAN LOGIC IS LEFT UNCHANGED.
  if(action==="ban"&&targetId!=="*")await saveBan(targetId);

  const c={action:String(action),targetId:String(targetId),room:String(room),freeze:!!freeze,x:Number(x)||0,y:Number(y)||0,z:Number(z)||0,message:String(message||""),createdAt:Date.now()};
  const id=await enqueueCommand(c);
  res.json({ok:true,id});
}catch(e){console.error("/admin/command:",e);res.status(500).json({error:e.message});}});

app.get("/admin/commands",async(req,res)=>{try{
  const playerId=String(req.query.playerId||"");
  const room=String(req.query.room||"");
  const after=Number(req.query.after||0);
  if(!playerId||!room)return res.status(400).json({error:"Missing playerId or room"});
  if(!redis)return res.status(503).json({error:"Command queue is not configured"});

  const key=commandKey(room);
  const raw=await redis.zrangebyscore(key,`(${after}`,"+inf");
  const commands=[];
  for(const item of raw){
    try{
      const c=JSON.parse(item);
      if(c.room===room&&(c.targetId==="*"||sameId(c.targetId,playerId)))commands.push(c);
    }catch{}
  }

  const latestId=commands.length?Math.max(after,...commands.map(c=>Number(c.id)||0)):after;
  res.json({latestId,commands});
}catch(e){console.error("/admin/commands:",e);res.status(500).json({error:e.message});}});

app.get("/health",(req,res)=>res.json({ok:true,allowCodeAdmins:ALLOW_CODE_ADMINS}));
app.get("/",(req,res)=>res.send("Gorilla Tag Mod Backend API is live."));
app.listen(PORT,"0.0.0.0",()=>console.log(`GTag backend listening on ${PORT}`));
