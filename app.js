require('dotenv').config();
require('colors');
const express = require('express');
const ExpressWs = require('express-ws');
const { CallbackHandler } = require('langfuse-langchain');

const { GptService } = require('./services/gpt-service');
const { StreamService } = require('./services/stream-service');
const { TranscriptionService } = require('./services/transcription-service');
const { TextToSpeechService } = require('./services/tts-service');

const { Mutex } = require('async-mutex');
const ttsQueue = new Mutex();

const app = express();
ExpressWs(app);

const PORT = process.env.PORT || 8089;

const langfuseLangchainHandler = new CallbackHandler({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_HOST,
});

app.post('/', (req, res) => {
  console.log('Получен входящий запрос на /');

  res.status(200);
  res.type('text/xml');
  res.end(`
  <Response>
    <Connect>
      <Stream url="wss://${process.env.SERVER}/ws" />
    </Connect>
  </Response>
  `);
});

app.ws('/ws', (ws) => {
  console.log('Установлено WebSocket соединение');
  ws.setMaxListeners(30); // Увеличьте лимит до 30 (или другого подходящего значения)

  ws.on('error', console.error);
  let streamSid;
  let callSid;
  let from;

  const gptService = new GptService();

  const streamService = new StreamService(ws);
  const transcriptionService = new TranscriptionService();
  const ttsService = new TextToSpeechService({});
  
  let marks = [];
  let interactionCount = 0;

  ws.on('message', async function message(data) {
    const msg = JSON.parse(data);
      
    ws.on('error', (error) => {
      console.error(`Ошибка WebSocket: ${error}`);
    });

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid;
      from = msg.start.customParameters.from;
      const sessionId = `session-${from}`;

      streamService.setStreamSid(streamSid);
      gptService.setCallSid(callSid);
      gptService.setStreamSid(streamSid);
      ttsService.setCallSid(callSid);
      ttsService.setStreamSid(streamSid);

      console.log(`Twilio -> Начало потока медиа для ${streamSid}`.underline.red);

      await gptService.loadPrompt('Яндекс Еда');
      ttsService.generate({partialResponseIndex: null, partialResponse:  'Алло! Здравствуйте, это Константин?' }, 1);

      langfuseLangchainHandler.handleChainStart(
        { id: ['call'] },
        {},
        `call-${callSid}-${streamSid}`,
        undefined,
        undefined,
        { sessionId },
        'call',
        'Call'
      );

    } else if (msg.event === 'media') {
      transcriptionService.send(msg.media.payload);
    } else if (msg.event === 'mark') {
      const label = msg.mark.name;
      console.log(`Twilio -> Audio completed mark (${msg.sequenceNumber}): ${label}`.red);
      marks = marks.filter(m => m !== msg.mark.name);
    } else if (msg.event === 'stop') {
      console.log(`Twilio -> Media stream ${streamSid} ended.`.underline.red);

      langfuseLangchainHandler.handleLLMEnd({
        llm: 'openai',
        call_sid: callSid,
        stream_sid: streamSid,
      });
    }
  });

  transcriptionService.on('utterance', async (text) => {
    if(marks.length > 0 && text?.length > 5) {
      console.log('Twilio -> Interruption, Clearing stream'.red);
      ws.send(
        JSON.stringify({
          streamSid,
          event: 'clear',
        })
      );
    }
  });

  transcriptionService.on('transcription', async (text) => {
    if (!text) { return; }
    console.log(`Interaction ${interactionCount} – STT -> GPT: ${text}`.yellow);
    gptService.completion(text, interactionCount);
    interactionCount += 1;
  });
  
  gptService.on('gptreply', async (gptReply, icount) => {
    console.log(`Interaction ${icount}: GPT -> TTS: ${gptReply.partialResponse}`.green);
  
    langfuseLangchainHandler.handleLLMEnd(
      { generations: [[{ text: gptReply.partialResponse }]], llmOutput: {} },
      `gpt-completion-${callSid}-${streamSid}-${icount}`
    );
  
    await ttsQueue.runExclusive(async () => {
      await ttsService.generate(gptReply, icount);
    });
  });

  ttsService.on('speech', (responseIndex, audio, label, icount) => {
    console.log(`Interaction ${icount}: TTS -> TWILIO: ${label}`.blue);

    streamService.buffer(responseIndex, audio);
  });

  streamService.on('audiosent', (markLabel) => {
    marks.push(markLabel);
  });
});

app.listen(PORT);
console.log(`Server running on port ${PORT}`);