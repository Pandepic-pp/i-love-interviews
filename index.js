import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import OpenAI, { toFile } from 'openai';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage() });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ── Helper: upload buffer to S3 ────────────────────────
async function uploadToS3(buffer, fileName, contentType) {
  const key = `interviews/${Date.now()}-${fileName}`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return key;
}

// ── Helper: extract plain text from resume buffer ──────
async function extractResumeText(buffer, originalName) {
  const ext = originalName.split('.').pop().toLowerCase();

  if (ext === 'pdf') {
    const parser = new PDFParse({data: buffer});
    const result = await parser.getText();
    await parser.destroy();
    return result.text;
  }

  if (ext === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === 'doc') {
    // mammoth handles older .doc too, best-effort
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // Plain text fallback
  return buffer.toString('utf-8');
}

// ── Route 1: /generate-question ────────────────────────
// Accepts resume file, extracts text, asks GPT to generate
// one focused technical interview question from the content.
app.post('/generate-question', upload.single('resume'), async (req, res) => {
  try {
    const buffer = req.file.buffer;
    const fileName = req.file.originalname;

    // Upload resume to S3 for records
    const s3Key = await uploadToS3(buffer, fileName, req.file.mimetype);
    console.log('[S3] Resume uploaded:', s3Key);

    // Extract text
    const resumeText = await extractResumeText(buffer, fileName);
    if (!resumeText || resumeText.trim().length < 50) {
      return res.status(400).json({ error: 'Could not extract enough text from résumé.' });
    }

    console.log(`[Resume] Extracted ${resumeText.length} characters`);

    // Ask GPT to generate a targeted technical question
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a senior technical interviewer. 
You will receive a candidate's résumé. Your job is to generate ONE strong technical interview question based on their most prominent skill, project, or technology mentioned.

Rules:
- Pick the most technically interesting or specific thing on the résumé
- Ask something that requires real depth to answer, not a definition
- The question should be 2-3 sentences max
- Do NOT mention the candidate's name or reference their résumé directly (e.g. don't say "I see you worked at...")
- Return ONLY the question text. Nothing else.`
        },
        {
          role: 'user',
          content: `Résumé:\n\n${resumeText.slice(0, 6000)}` // cap tokens
        }
      ],
      max_tokens: 200,
      temperature: 0.7,
    });

    const question = completion.choices[0].message.content.trim();
    console.log('[GPT] Generated question:', question);
    res.json({ question, s3Key });

  } catch (err) {
    console.error('[/generate-question] Error:', err);
    res.status(500).json({ error: 'Failed to generate question from résumé' });
  }
});

// ── Route 1: /transcribe ───────────────────────────────
// Uploads audio to S3, transcribes via Whisper
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    const buffer = req.file.buffer;

    // Save to S3 for record keeping
    const s3Key = await uploadToS3(buffer, 'recording.webm', 'audio/webm');
    console.log('[S3] Uploaded:', s3Key);

    // Transcribe using in-memory buffer
    const transcription = await openai.audio.transcriptions.create({
      file: await toFile(buffer, 'recording.webm', { type: 'audio/webm' }),
      model: 'whisper-1',
    });

    console.log('[Whisper] Transcript:', transcription.text);
    res.json({ text: transcription.text, s3Key });

  } catch (err) {
    console.error('[/transcribe] Error:', err);
    res.status(500).json({ error: 'Transcription failed' });
  }
});

// ── Route 2: /followup ─────────────────────────────────
// Takes Q1 + A1, returns a follow-up question via GPT
app.post('/followup', async (req, res) => {
  const { question, answer } = req.body;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a senior technical interviewer conducting a software engineering interview.
Your job is to ask ONE sharp, specific follow-up question based on the candidate's answer.
The follow-up should:
- Probe deeper into something they mentioned, OR expose a gap in their answer
- Be direct and concise (1–2 sentences max)
- Sound like a real interviewer, not a quiz
Return ONLY the follow-up question text. No preamble, no explanation.`
        },
        {
          role: 'user',
          content: `Original question: "${question}"\n\nCandidate's answer: "${answer}"\n\nFollow-up question:`
        }
      ],
      max_tokens: 150,
      temperature: 0.7,
    });

    const followup = completion.choices[0].message.content.trim();
    console.log('[GPT] Follow-up:', followup);
    res.json({ followup });

  } catch (err) {
    console.error('[/followup] Error:', err);
    res.status(500).json({ error: 'Follow-up generation failed' });
  }
});

// ── Route 3: /score ────────────────────────────────────
// Takes full conversation, returns score + breakdown + feedback
app.post('/score', async (req, res) => {
  const { q1, a1, q2, a2 } = req.body;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a senior engineering hiring manager evaluating a technical interview.
          You will be given a two-round interview transcript and must evaluate the candidate.

          Respond ONLY with valid JSON in this exact shape:
          {
            "score": <number 0–100>,
            "breakdown": {
              "Technical Accuracy": { "score": <0–10>, "comment": "<1 sentence>" },
              "Depth of Knowledge": { "score": <0–10>, "comment": "<1 sentence>" },
              "Communication":      { "score": <0–10>, "comment": "<1 sentence>" },
              "Problem Solving":    { "score": <0–10>, "comment": "<1 sentence>" }
            },
            "feedback": "<2–3 sentences of overall feedback with specific strengths and areas to improve>"
          }

          Be honest and critical. Do not inflate scores. The overall score should reflect the weighted average of breakdown scores.`
                  },
                  {
                    role: 'user',
                    content: `Round 1:
          Q: ${q1}
          A: ${a1}

          Round 2 (Follow-up):
          Q: ${q2}
          A: ${a2}`
        }
      ],
      max_tokens: 600,
      temperature: 0.4,
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0].message.content;
    const result = JSON.parse(raw);
    console.log('[GPT] Score:', result.score);
    res.json(result);

  } catch (err) {
    console.error('[/score] Error:', err);
    res.status(500).json({ error: 'Scoring failed' });
  }
});

// ── Start server ───────────────────────────────────────
app.listen(3000, () => {
  console.log('TechScreen running → http://localhost:3000');
});