const https = require('https');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const API_HOST = 'api.elevenlabs.io';

async function generateSpeech(text, voiceConfig) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY not configured');
  }

  const voiceId = voiceConfig.voice_id;
  if (!voiceId) {
    throw new Error('voice_id missing in voiceConfig');
  }

  const postData = JSON.stringify({
    text: String(text || ''),
    model_id: voiceConfig.model || 'eleven_turbo_v2_5',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75
    }
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: API_HOST,
      path: `/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 5000
    }, (res) => {
      if (res.statusCode !== 200) {
        let errorBody = '';
        res.on('data', chunk => errorBody += chunk);
        res.on('end', () => {
          reject(new Error(`ElevenLabs API error ${res.statusCode}: ${errorBody}`));
        });
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const durationEstimate = Math.max(1, Math.ceil(String(text || '').length / 15));
        resolve({
          audio_base64: buffer.toString('base64'),
          format: 'mp3',
          duration_estimate: durationEstimate
        });
      });
    });

    req.on('error', (err) => {
      reject(new Error(`ElevenLabs request error: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('ElevenLabs request timed out'));
    });

    req.write(postData);
    req.end();
  });
}

module.exports = { generateSpeech };
