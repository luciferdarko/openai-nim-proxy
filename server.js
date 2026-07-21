// server.js - OpenAI to NVIDIA NIM API Proxy (Updated for Roleplay)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 REASONING DISPLAY TOGGLE - Shows/hides reasoning in output
const SHOW_REASONING = true; // Helpful for DeepSeek R1 roleplay logic

// 🔥 THINKING MODE TOGGLE - Enables thinking for specific models that support it
const ENABLE_THINKING_MODE = true; 

// Updated Model Mapping: Top Roleplay & Interactive Creative Models on NVIDIA NIM
// Use the short aliases on the left in your frontend (e.g. SillyTavern)
const MODEL_MAPPING = {
  // --- NVIDIA NIM Specific Short Aliases ---
  'nemotron-70b': 'nvidia/llama-3.1-nemotron-70b-instruct',  // Top tier for RP alignment & character card adherence
  'llama-3.3-70b': 'meta/llama-3.3-70b-instruct',            // Excellent multi-turn coherence and general RP
  'llama-405b': 'meta/llama-3.1-405b-instruct',              // Massive context for heavy worldbuilding
  'llama-8b': 'meta/llama-3.1-8b-instruct',                  // Ultra-fast for quick interactive chatter
  'mistral-large': 'mistralai/mistral-large-2407',           // Extremely natural, expressive prose & storytelling
  'qwen-72b': 'qwen/qwen2.5-72b-instruct',                   // Deep logic, context retention, and instruction following
  'qwen-7b': 'qwen/qwen2.5-7b-instruct',                     // Lightweight Qwen series fallback
  'deepseek-r1': 'deepseek-ai/deepseek-r1',                  // Complex RPG system logic, stats, and reasoning

  // --- Standard OpenAI / Claude Compatibility Aliases ---
  'gpt-4o': 'nvidia/llama-3.1-nemotron-70b-instruct',        
  'gpt-4-turbo': 'meta/llama-3.1-405b-instruct',             
  'gpt-4': 'mistralai/mistral-large-2407',
  'gpt-3.5-turbo': 'meta/llama-3.1-8b-instruct',
  'claude-3-5-sonnet': 'meta/llama-3.3-70b-instruct',
  'claude-3-opus': 'qwen/qwen2.5-72b-instruct'
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy', 
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

// List models endpoint (OpenAI compatible)
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

// Chat completions endpoint (main proxy)
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    // Smart model selection with fallback
    let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      try {
        await axios.post(`${NIM_API_BASE}/chat/completions`, {
          model: model,
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 1
        }, {
          headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
          validateStatus: (status) => status < 500
        }).then(res => {
          if (res.status >= 200 && res.status < 300) {
            nimModel = model;
          }
        });
      } catch (e) {}
      
      // Fallback router based on keyword matching
      if (!nimModel) {
        const modelLower = (model || '').toLowerCase();
        if (modelLower.includes('nemotron')) {
          nimModel = 'nvidia/llama-3.1-nemotron-70b-instruct';
        } else if (modelLower.includes('deepseek-r1') || modelLower.includes('reasoning')) {
          nimModel = 'deepseek-ai/deepseek-r1';
        } else if (modelLower.includes('gpt-4o') || modelLower.includes('405b')) {
          nimModel = 'meta/llama-3.1-405b-instruct';
        } else if (modelLower.includes('mistral') || modelLower.includes('large') || modelLower.includes('gpt-4')) {
          nimModel = 'mistralai/mistral-large-2407';
        } else if (modelLower.includes('qwen') || modelLower.includes('72b') || modelLower.includes('opus')) {
          nimModel = 'qwen/qwen2.5-72b-instruct';
        } else if (modelLower.includes('claude') || modelLower.includes('3.3') || modelLower.includes('70b')) {
          nimModel = 'meta/llama-3.3-70b-instruct';
        } else {
          nimModel = 'meta/llama-3.1-8b-instruct'; // Fast fallback
        }
      }
    }
    
    // Specifically enable NIM tool calling & reasoning properties for DeepSeek R1
    let extraBody = undefined;
    if (ENABLE_THINKING_MODE && nimModel === 'deepseek-ai/deepseek-r1') {
      extraBody = { chat_template_kwargs: { enable_thinking: true, force_nonempty_content: true } };
    }

    // Transform OpenAI request to NIM format
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature !== undefined ? temperature : 0.85, // 0.85 is often the sweet spot for RP
      max_tokens: max_tokens || 4096,
      extra_body: extraBody,
      stream: stream || false
    };
    
    // Make request to NVIDIA NIM API
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });
    
    if (stream) {
      // Handle streaming response with reasoning
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let buffer = '';
      let reasoningStarted = false;
      
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) {
              res.write(line + '\n');
              return;
            }
            
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;
                
                if (SHOW_REASONING) {
                  let combinedContent = '';
                  
                  if (reasoning && !reasoningStarted) {
                    combinedContent = '<think>\n' + reasoning;
                    reasoningStarted = true;
                  } else if (reasoning) {
                    combinedContent = reasoning;
                  }
                  
                  if (content && reasoningStarted) {
                    combinedContent += '</think>\n\n' + content;
                    reasoningStarted = false;
                  } else if (content) {
                    combinedContent += content;
                  }
                  
                  if (combinedContent) {
                    data.choices[0].delta.content = combinedContent;
                    delete data.choices[0].delta.reasoning_content;
                  }
                } else {
                  if (content) {
                    data.choices[0].delta.content = content;
                  } else {
                    data.choices[0].delta.content = '';
                  }
                  delete data.choices[0].delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
              res.write(line + '\n');
            }
          }
        });
      });
      
      response.data.on('end', () => res.end());
      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.end();
      });
    } else {
      // Transform NIM response to OpenAI format with reasoning
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => {
          let fullContent = choice.message?.content || '';
          
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            fullContent = '<think>\n' + choice.message.reasoning_content + '\n</think>\n\n' + fullContent;
          }
          
          return {
            index: choice.index,
            message: {
              role: choice.message.role,
              content: fullContent
            },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      res.json(openaiResponse);
    }
    
  } catch (error) {
    console.error('Proxy error:', error.response?.data || error.message);
    
    res.status(error.response?.status || 500).json({
      error: {
        message: error.response?.data?.detail || error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

// Catch-all for unsupported endpoints
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Reasoning display: ${SHOW_REASONING ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Thinking mode: ${ENABLE_THINKING_MODE ? 'ENABLED' : 'DISABLED'}`);
});
