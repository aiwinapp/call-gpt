const EventEmitter = require('events');
const uuid = require('uuid');
const { Readable } = require('stream');

class StreamService extends EventEmitter {
  constructor(websocket) {
    super();
    this.ws = websocket;
    this.expectedAudioIndex = 0;
    this.audioBuffer = {};
    this.streamSid = '';
    this.waitingForMark = false;
  }

  setStreamSid(streamSid) {
    this.streamSid = streamSid;
  }

  async waitForMark() {
    return new Promise((resolve) => {
      setTimeout(resolve, 1000); // Ждем 1 секунду после отправки события 'mark'
    });
  }

  async buffer(index, audioStream) {
    const markLabel = uuid.v4();
  
    if (this.waitingForMark) {
      await this.waitForMark();
    }
  
    // Читаем аудио поток и отправляем данные через WebSocket
    audioStream.on('data', (chunk) => {
      this.ws.send(
        JSON.stringify({
          streamSid: this.streamSid,
          event: 'media',
          media: {
            payload: chunk.toString('base64'),
          },
        })
      );
    });
  
    audioStream.on('end', () => {
      this.ws.send(
        JSON.stringify({
          streamSid: this.streamSid,
          event: 'mark',
          mark: {
            name: markLabel,
          },
        })
      );
      this.waitingForMark = true;
      this.emit('audiosent', markLabel);
    });
  }
}

module.exports = { StreamService };