import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import fetch from 'node-fetch'; // Polyfill if needed
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'db.json');
const JWT_SECRET = process.env.JWT_SECRET || 'neuralpath-super-secret-key';

// Initialize DB safely
async function initDB() {
  try {
    await fs.access(DB_FILE);
  } catch {
    await fs.writeFile(DB_FILE, JSON.stringify({ users: [], activities: [] }, null, 2));
  }
}
initDB();

async function readDB() {
  const data = await fs.readFile(DB_FILE, 'utf-8');
  return JSON.parse(data);
}
async function writeDB(data) {
  await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

// Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send("Server is running"));

const PORT = process.env.PORT || 3000;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = "llama-3.3-70b-versatile";

// Helper function to safely extract and parse JSON from the LLM's response
function safeJSON(rawString) {
  try {
    return JSON.parse(rawString);
  } catch (error) {
    // If exact parsing fails, try extracting between first { and last }
    const startIndex = rawString.indexOf('{');
    const endIndex = rawString.lastIndexOf('}');
    if (startIndex !== -1 && endIndex !== -1) {
      const jsonStr = rawString.substring(startIndex, endIndex + 1);
      try {
        return JSON.parse(jsonStr);
      } catch (err2) {
        console.error("Second attempt JSON parsing failed:", err2);
        throw new Error("Failed to parse AI response");
      }
    }
    throw new Error("No JSON object found in response");
  }
}

// System prompt level configurations
const getLevelInstructions = (level) => {
  const levels = {
    "class6": "Use very simple words. Use examples from games, food, or cartoons. Target age is 11-12.",
    "class8": "Be clear and easy. Use typical school subject examples. Target age is 13-14.",
    "class10": "Use proper subject words with clear explanations. Target age is 15-17.",
    "college": "Use technical and academic language. Provide deeper, more nuanced explanations.",
    "curious": "Be friendly and conversational. Avoid heavy jargon unless necessary, use everyday stories."
  };
  return levels[level] || levels["curious"];
};

// 1. POST /explain
app.post('/explain', async (req, res) => {
  const { topic, level = "curious" } = req.body;
  if (!topic) return res.status(400).json({ error: "Topic is required" });

  try {
    const levelStyle = getLevelInstructions(level);
    const systemPrompt = `You are NeuralPath, an AI learning system designed to build real understanding — not just give answers.

Your teaching method strictly follows this structure:

1. Explain the concept clearly based on the user's level.
2. Keep explanations concise but deep — avoid unnecessary length.
3. Identify difficult words and wrap them in [[double brackets]].
4. Ensure every complex term wrapped has a matching definition later.

Audience Level Profile: ${levelStyle}

RULES:
- Do NOT overload the user (Cognitive Load Theory)
- Break ideas into small understandable chunks
- Use examples whenever possible
- Make the explanation intuitive, not textbook-like
- Avoid robotic tone

OUTPUT FORMAT (STRICT JSON ONLY WITHOUT MARKDOWN WRAPPING):
{
  "explanation": "string (with [[terms]])",
  "complex_terms": {
    "term1": "simple definition",
    "term2": "simple definition"
  },
  "related_concepts": [
    "concept 1",
    "concept 2",
    "concept 3"
  ],
  "image_query": "2-3 word search term",
  "topic_clean": "clean topic name"
}`;

    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Please explain: ${topic}` }
      ],
      model: MODEL,
      response_format: { type: "json_object" }
    });

    const aiContent = completion.choices[0]?.message?.content || "{}";
    const parsed = safeJSON(aiContent);
    res.json(parsed);
  } catch (error) {
    console.error("Error in /api/explain:", error);
    res.status(500).json({ error: "Failed to generate explanation" });
  }
});

// 2. POST /feedback
app.post('/feedback', async (req, res) => {
  const { topic, userExplanation, level = "curious" } = req.body;
  if (!topic || !userExplanation) return res.status(400).json({ error: "Topic and userExplanation are required" });

  try {
    const levelStyle = getLevelInstructions(level);
    const systemPrompt = `You are NeuralPath. You just taught the user about a topic, and now they are explaining it back to you.
Audience: ${levelStyle}
Focus: Evaluate their understanding. Be encouraging, praise effort (Growth Mindset).
Format required: Return ONLY a valid JSON object.

The JSON MUST have this structure:
{
  "score": "correct | partial | incorrect",
  "score_percent": <number 0-100>,
  "what_you_got_right": "1-2 sentences",
  "what_to_improve": "1-2 sentences",
  "feedback": "Overall constructive feedback",
  "misconception": "Any misconception corrected, or null if none",
  "encouragement": "A short, encouraging closing statement"
}`;

    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Topic: ${topic}\nUser's Explanation: ${userExplanation}` }
      ],
      model: MODEL,
      response_format: { type: "json_object" }
    });

    const aiContent = completion.choices[0]?.message?.content || "{}";
    const parsed = safeJSON(aiContent);
    res.json(parsed);
  } catch (error) {
    console.error("Error in /api/feedback:", error);
    res.status(500).json({ error: "Failed to generate feedback" });
  }
});

// 3. POST /quickexplain
app.post('/quickexplain', async (req, res) => {
  const { term, context, level = "curious" } = req.body;
  if (!term) return res.status(400).json({ error: "Term is required" });

  try {
    const levelStyle = getLevelInstructions(level);
    const systemPrompt = `You are NeuralPath. You need to quickly define a complex term that appeared in an explanation.
Context of the term: "${context || 'No specific context provided'}"
Audience: ${levelStyle}
Format required: Return ONLY a valid JSON object.

The JSON MUST have this structure:
{
  "simple_explanation": "1-2 short sentences",
  "analogy": "A simple everyday analogy",
  "example": "A concrete example"
}`;

    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Term to explain: ${term}` }
      ],
      model: MODEL,
      response_format: { type: "json_object" }
    });

    const aiContent = completion.choices[0]?.message?.content || "{}";
    const parsed = safeJSON(aiContent);
    res.json(parsed);
  } catch (error) {
    console.error("Error in /api/quickexplain:", error);
    res.status(500).json({ error: "Failed to fetch quick explanation" });
  }
});

// 4. POST /relatedconcept
app.post('/relatedconcept', async (req, res) => {
  const { concept, parentTopic, level = "curious" } = req.body;
  if (!concept || !parentTopic) return res.status(400).json({ error: "Concept and parentTopic are required" });

  try {
    const levelStyle = getLevelInstructions(level);
    const systemPrompt = `You are NeuralPath. You are explaining a related concept to the user.
Parent Topic: ${parentTopic}
Audience: ${levelStyle}
Format required: Return ONLY a valid JSON object.

The JSON MUST have this structure:
{
  "explanation": "Clear explanation of the related concept.",
  "connection": "Explain specifically how this relates to the parent topic.",
  "example": "An example of the related concept.",
  "image_query": "2-3 word Wikipedia search term"
}`;

    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Concept to explain: ${concept}` }
      ],
      model: MODEL,
      response_format: { type: "json_object" }
    });

    const aiContent = completion.choices[0]?.message?.content || "{}";
    const parsed = safeJSON(aiContent);
    res.json(parsed);
  } catch (error) {
    console.error("Error in /api/relatedconcept:", error);
    res.status(500).json({ error: "Failed to generate related concept" });
  }
});

// --- AUTHENTICATION ROUTES ---

// POST /signup
app.post('/signup', async (req, res) => {
  console.log("--> Request hit /signup route");
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: "All fields required" });
    }
    
    const db = await readDB();
    if (db.users.find(u => u.email === email)) {
      return res.status(400).json({ success: false, message: "User already exists" });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: Date.now().toString(), name, email, password: hashedPassword };
    db.users.push(newUser);
    await writeDB(db);
    
    const token = jwt.sign({ id: newUser.id, name: newUser.name }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, message: "Signup successful", token, user: { id: newUser.id, name: newUser.name, email: newUser.email } });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ success: false, message: "Signup failed" });
  }
});

// POST /login
app.post('/login', async (req, res) => {
  console.log("--> Request hit /login route");
  try {
    const { email, password } = req.body;
    const db = await readDB();
    const user = db.users.find(u => u.email === email);
    
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ success: false, message: "Invalid credentials" });
    }
    
    const token = jwt.sign({ id: user.id, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, message: "Login successful", token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, message: "Login failed" });
  }
});

// --- DASHBOARD & ACTIVITY ROUTES ---

// POST /activity/save
app.post('/activity/save', authenticateToken, async (req, res) => {
  try {
    const { topic, explanation, feedback, score } = req.body;
    const db = await readDB();
    
    const newActivity = {
      id: Date.now().toString(),
      userId: req.user.id,
      topic,
      explanation,
      feedback,
      score: Number(score) || 0,
      timestamp: new Date().toISOString()
    };
    
    db.activities.push(newActivity);
    await writeDB(db);
    res.json({ success: true, activity: newActivity });
  } catch (error) {
    console.error("Save Activity Error:", error);
    res.status(500).json({ error: "Failed to save activity" });
  }
});

// GET /dashboard
app.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    const db = await readDB();
    const userActivities = db.activities.filter(a => a.userId === req.user.id);
    
    // Sort chronological descending
    userActivities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    const totalSessions = userActivities.length;
    
    // unique topics
    const uniqueTopics = new Set(userActivities.map(a => a.topic.toLowerCase())).size;
    const averageScore = totalSessions > 0 
      ? Math.round(userActivities.reduce((acc, a) => acc + a.score, 0) / totalSessions)
      : 0;
      
    // Recent scores (last 5)
    // Map just the scores from the latest to oldest
    const recentScores = userActivities.slice(0, 5).map(a => a.score);
    
    res.json({
      totalSessions,
      topicsCompleted: uniqueTopics,
      averageScore,
      recentScores,
      history: userActivities
    });
  } catch (error) { res.status(500).json({ error: "Failed to fetch dashboard data" }); }
});

app.listen(PORT, () => {
  console.log(`NeuralPath API Server running on http://localhost:${PORT}`);
});
