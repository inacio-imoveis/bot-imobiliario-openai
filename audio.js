import fs from "fs";
import path from "path";
import { tmpdir } from "os";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Transcreve áudio a partir de base64
export async function transcribeBase64Audio(base64Data) {
  const tmpPath = path.join(tmpdir(), `audio_${Date.now()}.ogg`);
  try {
    const buffer = Buffer.from(base64Data, "base64");
    fs.writeFileSync(tmpPath, buffer);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: "whisper-1",
      language: "pt",
    });

    return transcription.text || null;
  } catch (err) {
    console.error("Erro ao transcrever áudio:", err.message);
    return null;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}
