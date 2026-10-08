// server.js - OpenAI to NVIDIA NIM API Proxy
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
const SHOW_REASONING = true;

// 🔥 THINKING MODE TOGGLE - Enables thinking for models supporting reasoning parameters
const ENABLE_THINKING_MODE = false; 

// Model Mapping: Custom list of NVIDIA NIM models & short aliases
const MODEL_MAPPING = {
  // Exact model IDs
  'moonshotai/kimi-k3': 'moonshotai/kimi-k3',
  'google/gemma-4-31b-it': 'google/gemma-4-31b-it',
  'z-ai/glm-5.3': 'z-ai/glm-5.3',
  'meta/muse-glimmer-30b': 'meta/muse-glimmer-30b',

  // Short aliases for frontends (JanitorAI, SillyTavern, etc.)
  'kimi-k3': 'moonshotai/kimi-k3',
  'gemma-4-31b': 'google/gemma-4-31b-it',
  'glm-5.3': 'z-ai/glm-5.3',
  'muse-glimmer-30b': 'meta/muse-glimmer-30b'
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

    if (!model) {
      return res.status(400).json({
        error: {
          message: 'Model parameter is required.',
          type: 'invalid_request_error',
          code: 400
        }
      });
    }
    
    // Resolve alias if mapped; otherwise, directly use the exact model path passed from JanitorAI
    const nimModel = MODEL_MAPPING[model] || model;

    // Build NIM request body
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature !== undefined ? temperature : 0.85,
      max_tokens: max_tokens || 4096,
      stream: stream || false,
      ...(ENABLE_THINKING_MODE
        ? { chat_template_kwargs: { enable_thinking: true, force_nonempty_content: true } }
        : {})
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
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let buffer = '';
      let reasoningStarted = false;
      
      response.data.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        
        lines.forEach(rawLine => {
          const line = rawLine.trim();
          if (!line || !line.startsWith('data: ')) return;

          if (line.includes('[DONE]')) {
            res.write(`${line}\n\n`);
            return;
          }
          
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]?.delta) {
              const delta = data.choices[0].delta;
              const reasoning = delta.reasoning_content;
              const content = delta.content;
              
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
                  delta.content = combinedContent;
                }
              } else {
                delta.content = content || '';
              }
              delete delta.reasoning_content;
            }
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch (e) {
            // Drop incomplete/malformed chunks safely
          }
        });
      });
      
      response.data.on('end', () => res.end());
      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.end();
      });
    } else {
      // Transform NIM non-stream response to standard OpenAI format
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
