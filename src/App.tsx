/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback, FormEvent } from 'react';
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { Mic, MicOff, Wallet, TrendingUp, History, Calendar as CalendarIcon, Trash2, Plus, Lock } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Types
interface Expense {
  id: number;
  amount: number;
  description: string;
  category_name: string;
  date: string;
}

interface Summary {
  daily: number;
  byCategory: { name: string; total: number }[];
}

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [summary, setSummary] = useState<Summary>({ daily: 0, byCategory: [] });
  const [status, setStatus] = useState<string>("Pronto para ouvir");
  const [lastResponse, setLastResponse] = useState<string>("");
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [isLocked, setIsLocked] = useState(true);
  const [isSetupNeeded, setIsSetupNeeded] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [authError, setAuthError] = useState("");
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const audioQueue = useRef<Int16Array[]>([]);
  const isPlaying = useRef(false);

  // Data persistence logic using localStorage
  const loadLocalData = useCallback(() => {
    const savedExpenses = localStorage.getItem('vozfinancas_expenses');
    if (savedExpenses) {
      const parsed = JSON.parse(savedExpenses);
      setExpenses(parsed);
      updateSummary(parsed);
    }
  }, []);

  const saveLocalData = (newExpenses: Expense[]) => {
    localStorage.setItem('vozfinancas_expenses', JSON.stringify(newExpenses));
    setExpenses(newExpenses);
    updateSummary(newExpenses);
  };

  const updateSummary = (allExpenses: Expense[]) => {
    const today = new Date().toISOString().split('T')[0];
    const daily = allExpenses
      .filter(e => e.date.startsWith(today))
      .reduce((sum, e) => sum + e.amount, 0);
    
    const categories: Record<string, number> = {};
    allExpenses.forEach(e => {
      categories[e.category_name] = (categories[e.category_name] || 0) + e.amount;
    });
    
    const byCategory = Object.entries(categories).map(([name, total]) => ({ name, total }));
    setSummary({ daily, byCategory });
  };

  // Check auth status on mount
  useEffect(() => {
    const storedPassword = localStorage.getItem('vozfinancas_password');
    setIsSetupNeeded(!storedPassword);
    loadLocalData();
  }, [loadLocalData]);

  const handleAuth = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError("");
    
    if (isSetupNeeded) {
      if (passwordInput.length < 4) {
        setAuthError("A senha deve ter pelo menos 4 caracteres");
        return;
      }
      localStorage.setItem('vozfinancas_password', passwordInput);
      setIsLocked(false);
      setIsSetupNeeded(false);
      setPasswordInput("");
    } else {
      const storedPassword = localStorage.getItem('vozfinancas_password');
      if (storedPassword === passwordInput) {
        setIsLocked(false);
        setPasswordInput("");
      } else {
        setAuthError("Senha incorreta");
      }
    }
  };

  // API Fallback logic (trying to keep it compatible with server if it exists)
  const fetchData = useCallback(async () => {
    // We prioritize localStorage for reliability on static hosts
    loadLocalData();
    
    // Optional: Sync with server if available
    try {
      const res = await fetch('/api/expenses');
      if (res.ok) {
        const data = await res.json();
        // If server has data, we could merge or overwrite, but for now let's stick to local for simplicity
        // saveLocalData(data); 
      }
    } catch (e) {
      console.log("Server not available, using local storage only.");
    }
  }, [loadLocalData]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Check permission on mount
  useEffect(() => {
    const checkPermission = async () => {
      try {
        const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        if (result.state === 'granted') {
          setHasPermission(true);
        } else if (result.state === 'denied') {
          setHasPermission(false);
        } else {
          setHasPermission(null); // Prompt needed
        }
        
        result.onchange = () => {
          setHasPermission(result.state === 'granted');
        };
      } catch (e) {
        console.warn("Permissions API not supported", e);
      }
    };
    checkPermission();

    // Try to trigger prompt automatically on mount (some browsers allow this)
    const timer = setTimeout(() => {
      if (hasPermission === null) {
        requestInitialPermission();
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [hasPermission]);

  const requestInitialPermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop()); // Just to trigger prompt
      setHasPermission(true);
    } catch (err) {
      console.error("Initial permission error:", err);
      setHasPermission(false);
    }
  };

  // Audio Playback logic
  const playNextInQueue = useCallback(() => {
    if (audioQueue.current.length === 0 || isPlaying.current) return;
    
    isPlaying.current = true;
    const chunk = audioQueue.current.shift()!;
    const audioContext = audioContextRef.current!;
    
    const buffer = audioContext.createBuffer(1, chunk.length, 24000);
    const channelData = buffer.getChannelData(0);
    for (let i = 0; i < chunk.length; i++) {
      channelData[i] = chunk[i] / 32768.0;
    }
    
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.onended = () => {
      isPlaying.current = false;
      playNextInQueue();
    };
    source.start();
  }, []);

  const stopRecording = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    setIsRecording(false);
    setStatus("Pronto para ouvir");
  }, []);

  const startRecording = async () => {
    if (isRecording) {
      stopRecording();
      return;
    }

    try {
      setStatus("Solicitando microfone...");
      
      // Check if mediaDevices is supported
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("NOT_SUPPORTED");
      }

      let stream: MediaStream;
      try {
        // Try with advanced constraints first
        stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          } 
        });
      } catch (e) {
        console.warn("Advanced constraints failed, trying simple audio:true", e);
        // Fallback to simple constraints
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      
      streamRef.current = stream;
      
      const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error("AUDIO_CONTEXT_NOT_SUPPORTED");
      }

      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContextClass({ sampleRate: 16000 });
      }
      const audioContext = audioContextRef.current;
      
      // Crucial for mobile: resume context on user gesture
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const source = audioContext.createMediaStreamSource(stream);
      
      // Analyser for silence detection
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      source.connect(analyser);

      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      setStatus("Conectando ao assistente...");
      const session = await ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: `Você é um assistente financeiro pessoal brasileiro chamado VozFinanças.
Sua tarefa é ajudar o usuário a registrar e consultar gastos por voz.
Sempre responda em Português Brasileiro de forma amigável e concisa.
Confirme cada registro com uma frase como "Gasto de [valor] com [descrição] registrado com sucesso. Deseja algo mais?".

Ferramentas disponíveis:
- add_expense(amount: number, description: string, category: string): Adiciona um novo gasto.
- get_expenses(): Retorna a lista de gastos recentes.
- delete_expense(id: number): Remove um gasto pelo ID.
- get_summary(): Retorna o resumo de gastos de hoje e por categoria.

Se o usuário perguntar "Quanto gastei hoje?", use get_summary.
Se o usuário disser "Adicionar gasto de 25 reais com café", use add_expense.
Se o usuário quiser apagar algo, liste os gastos recentes e peça para confirmar qual ID apagar ou use a descrição se for única.`,
          tools: [{
            functionDeclarations: [
              {
                name: "add_expense",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    amount: { type: Type.NUMBER, description: "O valor do gasto" },
                    description: { type: Type.STRING, description: "O que foi comprado" },
                    category: { type: Type.STRING, description: "A categoria do gasto (ex: Alimentação, Transporte)" }
                  },
                  required: ["amount", "description", "category"]
                }
              },
              {
                name: "get_expenses",
                parameters: { type: Type.OBJECT, properties: {} }
              },
              {
                name: "delete_expense",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.NUMBER, description: "O ID do gasto a ser removido" }
                  },
                  required: ["id"]
                }
              },
              {
                name: "get_summary",
                parameters: { type: Type.OBJECT, properties: {} }
              }
            ]
          }]
        },
        callbacks: {
          onopen: () => {
            setIsRecording(true);
            setStatus("Ouvindo...");
          },
          onmessage: async (message) => {
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.inlineData) {
                  const base64Data = part.inlineData.data;
                  const binaryString = atob(base64Data);
                  const len = binaryString.length;
                  const bytes = new Int16Array(len / 2);
                  for (let i = 0; i < len; i += 2) {
                    bytes[i / 2] = (binaryString.charCodeAt(i + 1) << 8) | binaryString.charCodeAt(i);
                  }
                  audioQueue.current.push(bytes);
                  playNextInQueue();
                }
                if (part.text) {
                  setLastResponse(part.text);
                }
              }
            }

            if (message.toolCall) {
              for (const call of message.toolCall.functionCalls) {
                let result;
                if (call.name === "add_expense") {
                  const newExpense: Expense = {
                    id: Date.now(),
                    amount: call.args.amount as number,
                    description: call.args.description as string,
                    category_name: call.args.category as string,
                    date: new Date().toISOString()
                  };
                  const updated = [...expenses, newExpense];
                  saveLocalData(updated);
                  result = { status: "success", expense: newExpense };
                  
                  // Background sync if server exists
                  fetch('/api/expenses', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(call.args)
                  }).catch(() => {});
                } else if (call.name === "get_expenses") {
                  result = expenses;
                } else if (call.name === "delete_expense") {
                  const updated = expenses.filter(e => e.id !== call.args.id);
                  saveLocalData(updated);
                  result = { status: "success" };
                  
                  // Background sync if server exists
                  fetch(`/api/expenses/${call.args.id}`, { method: 'DELETE' }).catch(() => {});
                } else if (call.name === "get_summary") {
                  result = summary;
                }
                
                session.sendToolResponse({
                  functionResponses: [{
                    name: call.name,
                    id: call.id,
                    response: { result }
                  }]
                });
              }
            }

            if (message.serverContent?.interrupted) {
              audioQueue.current = [];
              isPlaying.current = false;
            }
          },
          onclose: () => stopRecording(),
          onerror: (e) => {
            console.error("Live API Error:", e);
            setStatus("Erro na conexão com o assistente");
            stopRecording();
          }
        }
      });

      sessionRef.current = session;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Silence detection
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;

        if (average < 15) { // Threshold for silence (slightly higher for mobile noise)
          if (!silenceTimerRef.current) {
            silenceTimerRef.current = setTimeout(() => {
              console.log("Silence detected, stopping...");
              stopRecording();
            }, 3000); // Stop after 3 seconds of silence
          }
        } else {
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
        }

        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 32767;
        }
        const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
        session.sendRealtimeInput({
          media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
        });
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

    } catch (err: any) {
      console.error("Microphone error:", err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setStatus("Permissão de microfone negada. Ative nas configurações do navegador.");
      } else if (err.message === "NOT_SUPPORTED" || err.message === "AUDIO_CONTEXT_NOT_SUPPORTED") {
        setStatus("Seu navegador não suporta gravação de áudio.");
      } else {
        setStatus("Erro ao acessar microfone. Verifique as permissões.");
      }
    }
  };

  const filteredExpenses = expenses.filter(e => {
    const expenseDate = new Date(e.date).toISOString().split('T')[0];
    return expenseDate === selectedDate;
  });

  return (
    <div className="min-h-screen bg-[#F5F5F5] text-[#1A1A1A] font-sans selection:bg-emerald-100">
      {/* Auth Overlay */}
      <AnimatePresence>
        {isLocked && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] bg-white flex flex-col items-center justify-center p-8 text-center"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="max-w-xs w-full space-y-8"
            >
              <div className="w-24 h-24 bg-black rounded-3xl mx-auto flex items-center justify-center text-white shadow-2xl">
                <Wallet size={48} />
              </div>
              <div className="space-y-4">
                <h2 className="text-3xl font-bold tracking-tight">
                  {isSetupNeeded ? "Criar Senha" : "Acesso Restrito"}
                </h2>
                <p className="text-black/50 leading-relaxed">
                  {isSetupNeeded 
                    ? "Crie uma senha para proteger seus dados financeiros." 
                    : "Digite sua senha para acessar o VozFinanças."}
                </p>
              </div>
              <form onSubmit={handleAuth} className="space-y-4">
                <input 
                  type="password"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="Sua senha"
                  autoFocus
                  className="w-full p-4 bg-black/5 border-2 border-transparent rounded-2xl text-center font-mono text-xl focus:outline-none focus:border-black transition-colors"
                />
                {authError && <p className="text-xs text-red-500 font-bold">{authError}</p>}
                <button 
                  type="submit"
                  className="w-full py-5 bg-black text-white rounded-2xl font-bold text-lg shadow-xl hover:bg-zinc-800 active:scale-95 transition-all"
                >
                  {isSetupNeeded ? "Salvar Senha" : "Entrar"}
                </button>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Initial Permission Overlay */}
      <AnimatePresence>
        {!hasPermission && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-white flex flex-col items-center justify-center p-8 text-center"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="max-w-xs space-y-8"
            >
              <div className="w-24 h-24 bg-emerald-500 rounded-3xl mx-auto flex items-center justify-center text-white shadow-2xl shadow-emerald-200">
                <Mic size={48} />
              </div>
              <div className="space-y-4">
                <h2 className="text-3xl font-bold tracking-tight">Bem-vindo ao VozFinanças</h2>
                <p className="text-black/50 leading-relaxed">
                  Para começar a registrar seus gastos por voz, precisamos da sua permissão para usar o microfone.
                </p>
              </div>
              <div className="space-y-4">
                <button 
                  onClick={requestInitialPermission}
                  className="w-full py-5 bg-emerald-500 text-white rounded-2xl font-bold text-lg shadow-xl shadow-emerald-200 hover:bg-emerald-600 active:scale-95 transition-all"
                >
                  Ativar Microfone
                </button>
                {hasPermission === false && (
                  <p className="text-xs text-red-500 font-medium">
                    O microfone parece estar bloqueado. <br/>
                    Por favor, ative nas configurações do seu navegador.
                  </p>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Calendar Modal */}
      <AnimatePresence>
        {isCalendarOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsCalendarOpen(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-white w-full max-w-md rounded-3xl p-8 shadow-2xl space-y-6"
            >
              <div className="flex justify-between items-center">
                <h3 className="text-xl font-bold">Selecionar Data</h3>
                <button 
                  onClick={() => setIsCalendarOpen(false)}
                  className="w-10 h-10 rounded-full bg-black/5 flex items-center justify-center hover:bg-black/10 transition-colors"
                >
                  <Plus className="rotate-45" size={20} />
                </button>
              </div>
              
              <div className="space-y-4">
                <input 
                  type="date" 
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="w-full p-4 bg-emerald-50 border-2 border-emerald-100 rounded-2xl font-mono text-lg focus:outline-none focus:border-emerald-500 transition-colors"
                />
                <p className="text-sm text-black/40 text-center">
                  Mostrando gastos para o dia: <br/>
                  <span className="font-bold text-black">{new Date(selectedDate).toLocaleDateString('pt-BR', { dateStyle: 'long' })}</span>
                </p>
                <button 
                  onClick={() => setIsCalendarOpen(false)}
                  className="w-full py-4 bg-emerald-500 text-white rounded-2xl font-bold shadow-lg shadow-emerald-200 hover:bg-emerald-600 active:scale-95 transition-all"
                >
                  Confirmar
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="bg-white border-b border-black/5 px-6 py-4 flex justify-between items-center sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center text-white">
            <Wallet size={20} />
          </div>
          <h1 className="font-semibold text-lg tracking-tight">VozFinanças</h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-black/40 font-bold">Gasto Hoje</p>
            <p className="text-lg font-mono font-medium">R$ {summary.daily.toFixed(2)}</p>
          </div>
          <button 
            onClick={() => setIsLocked(true)}
            className="w-10 h-10 rounded-full bg-black/5 flex items-center justify-center hover:bg-black/10 transition-colors"
            title="Bloquear App"
          >
            <Lock size={18} />
          </button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-6 space-y-8 pb-32">
        {/* Voice Control Section */}
        <section className="bg-white rounded-3xl p-8 shadow-sm border border-black/5 flex flex-col items-center justify-center space-y-6 relative overflow-hidden">
          {isRecording && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="absolute inset-0 bg-emerald-50/50 pointer-events-none"
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <motion.div 
                  animate={{ scale: [1, 1.2, 1] }}
                  transition={{ repeat: Infinity, duration: 2 }}
                  className="w-64 h-64 bg-emerald-200/30 rounded-full blur-3xl"
                />
              </div>
            </motion.div>
          )}

          <div className="relative z-10 text-center space-y-2">
            <p className="text-sm font-medium text-black/60">{status}</p>
            {status.includes("Permissão") && (
              <button 
                onClick={startRecording}
                className="text-xs text-emerald-600 font-bold underline block mx-auto mt-2"
              >
                Tentar novamente
              </button>
            )}
            {lastResponse && (
              <motion.p 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-emerald-600 font-medium italic"
              >
                "{lastResponse}"
              </motion.p>
            )}
          </div>

          <button
            onClick={startRecording}
            className={`relative z-10 w-24 h-24 rounded-full flex items-center justify-center transition-all duration-300 shadow-lg ${
              isRecording 
                ? 'bg-red-500 text-white scale-110' 
                : 'bg-emerald-500 text-white hover:bg-emerald-600 active:scale-95'
            }`}
          >
            {isRecording ? <MicOff size={32} /> : <Mic size={32} />}
            {isRecording && (
              <span className="absolute inset-0 rounded-full border-4 border-red-200 animate-ping opacity-75" />
            )}
          </button>

          <p className="text-xs text-black/40 text-center max-w-xs">
            Toque no microfone e diga algo como:<br/>
            <span className="italic">"Gastei 15 reais com lanche"</span> ou <span className="italic">"Quanto gastei hoje?"</span>
          </p>
        </section>

        {/* Quick Stats */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white p-6 rounded-2xl border border-black/5 shadow-sm">
            <div className="flex items-center gap-2 text-black/40 mb-2">
              <TrendingUp size={16} />
              <span className="text-[10px] uppercase font-bold tracking-wider">Top Categoria</span>
            </div>
            <p className="text-xl font-medium">
              {summary.byCategory.sort((a, b) => b.total - a.total)[0]?.name || '---'}
            </p>
          </div>
          <div className="bg-white p-6 rounded-2xl border border-black/5 shadow-sm">
            <div className="flex items-center gap-2 text-black/40 mb-2">
              <History size={16} />
              <span className="text-[10px] uppercase font-bold tracking-wider">Registros</span>
            </div>
            <p className="text-xl font-medium">{expenses.length}</p>
          </div>
        </div>

        {/* Recent Expenses */}
        <section className="space-y-4">
          <div className="flex justify-between items-center px-2">
            <h2 className="font-semibold flex items-center gap-2">
              <History size={18} className="text-emerald-500" />
              {selectedDate === new Date().toISOString().split('T')[0] ? 'Gastos de Hoje' : `Gastos em ${new Date(selectedDate).toLocaleDateString('pt-BR')}`}
            </h2>
            <button 
              onClick={() => setIsCalendarOpen(true)}
              className="text-xs font-medium text-emerald-600 hover:underline flex items-center gap-1"
            >
              <CalendarIcon size={14} />
              Ver Calendário
            </button>
          </div>

          <div className="space-y-3">
            <AnimatePresence mode="popLayout">
              {filteredExpenses.length === 0 ? (
                <div className="text-center py-12 text-black/30 bg-white rounded-2xl border border-dashed border-black/10">
                  Nenhum gasto registrado para esta data.
                </div>
              ) : (
                filteredExpenses.map((expense) => (
                  <motion.div
                    key={expense.id}
                    layout
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="bg-white p-4 rounded-2xl border border-black/5 shadow-sm flex items-center justify-between group"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-600 font-bold text-xs">
                        {expense.category_name.substring(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium text-sm">{expense.description}</p>
                        <div className="flex items-center gap-2 text-[10px] text-black/40 font-medium">
                          <span className="bg-black/5 px-1.5 py-0.5 rounded uppercase">{expense.category_name}</span>
                          <span>•</span>
                          <span>{new Date(expense.date).toLocaleDateString('pt-BR')}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <p className="font-mono font-semibold text-sm">R$ {expense.amount.toFixed(2)}</p>
                      <button 
                        onClick={() => {
                          const updated = expenses.filter(e => e.id !== expense.id);
                          saveLocalData(updated);
                          fetch(`/api/expenses/${expense.id}`, { method: 'DELETE' }).catch(() => {});
                        }}
                        className="p-2 text-black/20 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </motion.div>
                ))
              )}
            </AnimatePresence>
          </div>
        </section>
      </main>

      {/* Floating Action Button (Manual Add - Optional/Backup) */}
      <button className="fixed bottom-8 right-8 w-14 h-14 bg-black text-white rounded-full shadow-2xl flex items-center justify-center hover:scale-110 active:scale-95 transition-transform z-20">
        <Plus size={24} />
      </button>
    </div>
  );
}
