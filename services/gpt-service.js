require('colors');
const EventEmitter = require('events');
const OpenAI = require('openai');
const tools = require('../functions/function-manifest');
const { CallbackHandler } = require('langfuse-langchain');

const langfuseLangchainHandler = new CallbackHandler({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_HOST,
  flushAt: 1 // cookbook-only: do not batch events, send them immediately
});

// Import all functions included in function manifest
// Note: the function name and file name must be the same
const availableFunctions = {};
tools.forEach((tool) => {
  let functionName = tool.function.name;
  availableFunctions[functionName] = require(`../functions/${functionName}`);
});

class GptService extends EventEmitter {
  constructor() {
    super();
    this.openai = new OpenAI();

    let offer = 'Яндекс еда предлагает курьерам до 650 рублей в час, ежедневные выплаты на карту, гибкий график работы. Вам было бы интересно?'

    this.userContext = [
      { 'role': 'system', 'content': 'Your name is Dmitry. First introduce youself: You are an HR manager who hires couriers for a job: '+offer+'\n\nIf user interested in offer: Your task is to collect a questionnaire ask questions.\n\n Questions: Citizenship, City in which you are willing to work, How much time you are willing to work? We offer a flexible schedule, so its important to know your availability.\n\n -----\n Vacancy courier food delivery conditions: Income up to 650 rubles per hour, payments every day on your card. Quick connection to the service. Daily payments. Convenient work schedule. Legal support. Injury insurance for direct self-employed couriers when performing a certain number of orders. Introduce yourself at the beginning of the dialog, you speak in a phone call. Make short messages and Ask maximum one question it is important cause you now in phone call. Speak in Russian and form text with "..." or "um" "so" pauses like in real phone call small talk "um" "so". Numbers print as words.' },
    ],
    this.partialResponseIndex = 0;
  }

  // Add the callSid to the chat context in case
  // ChatGPT decides to transfer the call.
  setCallSid (callSid) {
    this.userContext.push({ 'role': 'system', 'content': `callSid: ${callSid}` });
  }

  validateFunctionArgs (args) {
    try {
      return JSON.parse(args);
    } catch (error) {
      console.log('Warning: Double function arguments returned by OpenAI:', args);
      // Seeing an error where sometimes we have two sets of args
      if (args.indexOf('{') != args.lastIndexOf('{')) {
        return JSON.parse(args.substring(args.indexOf(''), args.indexOf('}') + 1));
      }
    }
  }

  updateUserContext(name, role, text) {
    if (name !== 'user') {
      this.userContext.push({ 'role': role, 'name': name, 'content': text });
    } else {
      this.userContext.push({ 'role': role, 'content': text });
    }
  }

  async completion(text, interactionCount) {
    this.updateUserContext('user', 'user', text);
  
    const runId = `gpt-completion-${this.callSid}-${this.streamSid}-${interactionCount}`;
    console.log(`GPT -> user context: ${JSON.stringify(this.userContext)})`);

    // Step 1: Send user transcription to Chat GPT
    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4-0125-preview',
      messages: this.userContext,
      temperature: 0,
      max_tokens: 200,
      stream: true,
    });
  
    const messagesWithHistory = this.userContext.map((msg, index) => ({
      content: msg.content,
      role: msg.role
    }));
  
    langfuseLangchainHandler.handleGenerationStart(
      { id: ['openai'] },
      messagesWithHistory,
      runId,
      undefined,
      { invocation_params: { model: 'gpt-4-0125-preview', max_tokens: 200, temperature: 0 } },
      undefined,
      { interactionCount },
      'gpt-completion'
    );
  
    let completeResponse = '';
    let partialResponse = '';
    let functionName = '';
    let functionArgs = '';
    let finishReason = '';
  
    function collectToolInformation(deltas) {
      let name = deltas.tool_calls[0]?.function?.name || '';
      if (name != '') {
        functionName = name;
      }
      let args = deltas.tool_calls[0]?.function?.arguments || '';
      if (args != '') {
        functionArgs += args;
      }
    }
  
    for await (const chunk of stream) {
      let content = chunk.choices[0]?.delta?.content || '';
      let deltas = chunk.choices[0].delta;
      finishReason = chunk.choices[0].finish_reason;
  
      if (deltas.tool_calls) {
        collectToolInformation(deltas);
      }
  
      if (finishReason === 'tool_calls') {
        const functionToCall = availableFunctions[functionName];
        const validatedArgs = this.validateFunctionArgs(functionArgs);
  
        const toolData = tools.find(tool => tool.function.name === functionName);
        const say = toolData.function.say;
  
        this.emit('gptreply', {
          partialResponseIndex: null,
          partialResponse: say
        }, interactionCount);
  
        let functionResponse = await functionToCall(validatedArgs);
  
        this.updateUserContext('function', functionName, functionResponse);
  
        await this.completion(functionResponse, interactionCount, 'function', functionName);
      } else {
        completeResponse += content;
        partialResponse += content;
        if (content.trim().slice(-1) === '•' || finishReason === 'stop') {
          const gptReply = {
            partialResponseIndex: this.partialResponseIndex,
            partialResponse
          };
  
          this.emit('gptreply', gptReply, interactionCount);
          this.partialResponseIndex++;
          partialResponse = '';
        }
      }
    }
  
    this.userContext.push({ 'role': 'assistant', 'content': completeResponse });
  
    const assistantMessage = {
      role: 'assistant',
      content: completeResponse
    };
  
    langfuseLangchainHandler.handleLLMEnd(
      { generations: [[assistantMessage]], llmOutput: { tokenUsage: stream.usage } },
      runId
    );
  
    console.log(`GPT -> user context length: ${this.userContext.length}`.green);
  }

  setCallSid (callSid) {
    this.callSid = callSid;
  }
  
  setStreamSid (streamSid) {
    this.streamSid = streamSid;
  }
}

module.exports = { GptService };