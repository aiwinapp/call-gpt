const EventEmitter = require('events');
const { Buffer } = require('node:buffer');
const fetch = require('node-fetch');
const crypto = require('crypto');
const Redis = require('ioredis');
const { Readable } = require('stream');
const { CallbackHandler } = require('langfuse-langchain'); // Добавьте эту строку

const { spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const langfuseLangchainHandler = new CallbackHandler({ // Добавьте этот блок
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_HOST,
  flushAt: 1 // cookbook-only: do not batch events, send them immediately
});

// Увеличение лимита максимального количества слушателей
EventEmitter.defaultMaxListeners = 20;

class TextToSpeechService extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.config.voiceId ||= process.env.VOICE_ID;
    this.nextExpectedIndex = 0;
    this.speechBuffer = {};
    this.cache = new Redis({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      db: process.env.REDIS_DB,
      password: process.env.REDIS_PASSWORD,
    });
    this.callSid = '';
    this.streamSid = '';
  }
  async getAudioData(sentence, ttsService = 'openai', optimizeStreamingLatency = 0) {
    ttsService = 'elevenlabs'

    switch (ttsService) {
      case 'openai':
        return await this.getAudioDataOpenAI(sentence);

      case 'elevenlabs':
        return await this.getAudioDataElevenLabs(sentence, optimizeStreamingLatency)
        
      default:
        return await this.getAudioDataOpenAI(sentence);
    }
  }
  
  async getAudioStream(sentence) {
    const audioData = await this.getAudioData(sentence, 0);
    return Readable.from(audioData);
  }
  
  async generateAudio(sentence) {
    return await this.getAudioData(sentence, 0);
  }


  getCacheKey(sentence) {
    const normalizedSentence = sentence.trim().toLowerCase();
    const hash = crypto.createHash('sha256').update(normalizedSentence).digest('hex');
    return `audio:${hash}`;
  }
  
  async convertToUlaw(wavBuffer) {
    return new Promise((resolve, reject) => {
      const ffmpegProcess = spawn(ffmpeg, [
        '-i', '-',
        '-ar', '8000',
        '-ac', '1',
        '-acodec', 'pcm_mulaw',
        '-f', 'mulaw',
        '-'
      ]);
  
      ffmpegProcess.stdin.write(wavBuffer);
      ffmpegProcess.stdin.end();
  
      const chunks = [];
      ffmpegProcess.stdout.on('data', chunk => {
        chunks.push(chunk);
      });
  
      ffmpegProcess.on('close', code => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(`ffmpeg exited with code ${code}`);
        }
      });
    });
  }
  
  async getAudioDataOpenAI(sentence) {
    const cacheKey = `openai:${this.getCacheKey(sentence)}`;
    const cachedAudio = await this.cache.getBuffer(cacheKey);
  
    if (cachedAudio) {
      console.log(`Using cached audio for sentence: ${sentence} [OpenAI]`);
      return cachedAudio;
    } else {
      try {
        const response = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: "tts-1-hd",
            input: sentence,
            voice: "nova",
            response_format: "wav"
          }),
        });
  
        if (!response.ok) {
          throw new Error(`Error generating speech [OpenAI]: ${response.statusText}`);
        }
  
        const audioBuffer = await response.arrayBuffer();
  
        // Перекодирование аудио в формат ulaw_8000
        const wavBuffer = Buffer.from(audioBuffer);
        const ulawBuffer = await this.convertToUlaw(wavBuffer);
  
        await this.cache.set(cacheKey, ulawBuffer);
  
        console.log(`Generated new audio for sentence: ${sentence} [OpenAI]`);
        return ulawBuffer;
      } catch (err) {
        console.error('Error occurred in TextToSpeech service [OpenAI]');
        console.error(err);
        this.emit('error', err);
      }
    }
  }

  async getAudioDataElevenLabs(sentence, optimizeStreamingLatency) {
    const cacheKey = this.getCacheKey(sentence);
    const cachedAudio = await this.cache.getBuffer(cacheKey);

    if (cachedAudio) {
      console.log(`Using cached audio for sentence: ${sentence} [ElevenLabs]`);
      return cachedAudio;
    } else {
      try {
        const outputFormat = 'ulaw_8000';
        const response = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${this.config.voiceId}/stream?output_format=${outputFormat}&optimize_streaming_latency=${optimizeStreamingLatency}`,
          {
            method: 'POST',
            headers: {
              'xi-api-key': process.env.XI_API_KEY,
              'Content-Type': 'application/json',
              accept: 'audio/wav',
            },
            body: JSON.stringify({
              model_id: process.env.XI_MODEL_ID,
              text: sentence,
              "voice_settings": {
                "similarity_boost": 0,
                "stability": 1,
                "style": 0,
                "use_speaker_boost": true
              }
            }),
          }
        );
  

        if (!response.ok) {
          throw new Error(`Error generating speech [ElevenLabs]: ${response.statusText}`);
        }

        const audioBuffer = await response.buffer();
        await this.cache.set(cacheKey, audioBuffer);

        console.log(`Generated new audio for sentence: ${sentence} [ElevenLabs]`);
        return audioBuffer;
      } catch (err) {
        console.error('Error occurred in TextToSpeech service [ElevenLabs]');
        console.error(err);
        this.emit('error', err);
      }
    }
  }

  async generate(gptReply, interactionCount) {
    const { partialResponseIndex, partialResponse } = gptReply;
    if (!partialResponse) {
      return;
    }
  
    const runId = `${this.callSid}-${this.streamSid}-${interactionCount}`;

    langfuseLangchainHandler.handleToolStart(
      { id: ['elevenlabs'] },
      partialResponse,
      runId,
      undefined,
      undefined,
      undefined,
      'elevenlabs'
    );
    const sentences = partialResponse.split(/(?<=[.!?])\s+/);
  
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const audioStream = await this.getAudioStream(sentence);
      this.emit('speech', partialResponseIndex, audioStream, sentence, interactionCount);
    }
  
    langfuseLangchainHandler.handleToolEnd('Audio generated', runId);
  }

  setCallSid (callSid) {
    this.callSid = callSid;
  }
  
  setStreamSid (streamSid) {
    this.streamSid = streamSid;
  }
}

module.exports = { TextToSpeechService };