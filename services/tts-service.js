const EventEmitter = require('events');
const { Buffer } = require('node:buffer');
const fetch = require('node-fetch');
const crypto = require('crypto');
const Redis = require('ioredis');
const { Readable } = require('stream'); // Добавьте эту строку

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
  }

  async getAudioStream(sentence) {
    const cacheKey = this.getCacheKey(sentence);
    const cachedAudio = await this.cache.get(cacheKey);
  
    if (cachedAudio) {
      console.log(`Использование кешированного аудио для фразы: ${sentence}`);
      // Создаем читаемый поток из кешированных аудио данных
      const readableStream = Readable.from(cachedAudio);
      return readableStream;
    } else {
      try {
        const outputFormat = 'ulaw_8000';
        const response = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${this.config.voiceId}/stream?output_format=${outputFormat}&optimize_streaming_latency=0`,
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
                "similarity_boost": 0.63,
                "stability": 0.36,
                "style": 0.32,
                "use_speaker_boost": true
              }
            }),
          }
        );
  
        if (!response.ok) {
          throw new Error(`Error generating speech: ${response.statusText}`);
        }
  
        const audioStream = response.body;
  
        // Читаем аудио поток и сохраняем его в кеш как строку или буфер
        const audioData = [];
        for await (const chunk of audioStream) {
          audioData.push(chunk);
        }
        const audioBuffer = Buffer.concat(audioData);
        this.cache.set(cacheKey, audioBuffer).catch((err) => {
          console.error('Error caching audio data:', err);
        });
  
        console.log(`Сгенерировано новое аудио для фразы: ${sentence}`);
        return Readable.from(audioBuffer);
      } catch (err) {
        console.error('Error occurred in TextToSpeech service');
        console.error(err);
        this.emit('error', err);
      }
    }
  }


  async generateAudio(sentence) {
    const cacheKey = this.getCacheKey(sentence);
    const cachedAudio = await this.cache.get(cacheKey);

    if (cachedAudio) {
      console.log(`Использование кешированного аудио для фразы: ${sentence}`);
      return Buffer.from(cachedAudio, 'base64');
    } else {
      try {
        const outputFormat = 'ulaw_8000';
        const response = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${this.config.voiceId}/stream?output_format=${outputFormat}&optimize_streaming_latency=0`,
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
                "similarity_boost": 0.63,
                "stability": 0.36,
                "style": 0.32,
                "use_speaker_boost": true
              }
              // "voice_settings": {
              //   "stability": 1,
              //   "similarity_boost": 1,
              //   "use_speaker_boost": true
              // }
            })
          }
        );

        if (!response.ok) {
          throw new Error(`Error generating speech: ${response.statusText}`);
        }

        const audioArrayBuffer = await response.arrayBuffer();
        const audioBuffer = Buffer.from(audioArrayBuffer);
        const audioBase64 = audioBuffer.toString('base64');

        await this.cache.set(cacheKey, audioBase64);

        console.log(`Сгенерировано новое аудио для фразы: ${sentence}`);
        return audioBuffer;
      } catch (err) {
        console.error('Error occurred in TextToSpeech service');
        console.error(err);
        this.emit('error', err);
      }
    }
  }

  getCacheKey(sentence) {
    const normalizedSentence = sentence.trim().toLowerCase();
    const hash = crypto.createHash('sha256').update(normalizedSentence).digest('hex');
    return `audio:${hash}`;
  }

  // async generate(gptReply, interactionCount) {
  //   const { partialResponseIndex, partialResponse } = gptReply;
  //   if (!partialResponse) {
  //     return;
  //   }

  //   const sentences = partialResponse.split(/(?<=[.!?])\s+/);

  //   for (let i = 0; i < sentences.length; i++) {
  //     const sentence = sentences[i];
  //     const audioBuffer = await this.generateAudio(sentence);
  //     const audioBase64 = audioBuffer.toString('base64');
  //     this.emit('speech', partialResponseIndex, audioBase64, sentence, interactionCount);
  //   }
  // }

  async generate(gptReply, interactionCount) {
    const { partialResponseIndex, partialResponse } = gptReply;
    if (!partialResponse) {
      return;
    }
  
    const sentences = partialResponse.split(/(?<=[.!?])\s+/);
  
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const audioStream = await this.getAudioStream(sentence);
      this.emit('speech', partialResponseIndex, audioStream, sentence, interactionCount);
    }
  }


}

module.exports = { TextToSpeechService };