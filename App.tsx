
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { FileUpload } from './components/FileUpload';
import { VideoStage } from './components/VideoStage';
import type { ContextualImageItem } from './types';


interface AssemblyAIWord {
  text: string;
  start: number; // in ms
  end: number; // in ms
  confidence?: number;
}

interface ScriptSegment {
  text: string;
  startTime: number; // in seconds
  endTime: number; // in seconds
  words: AssemblyAIWord[];
  visualQueryForPixabay?: string | null;
  pixabayFetchStatus?: 'idle' | 'suggesting' | 'fetching' | 'fetched' | 'failed_suggestion' | 'failed_fetch' | 'no_image_found';
}

type ContextualImagesState = Record<number, ContextualImageItem | null>;
type InputMode = 'file' | 'url' | 'preset'; // Added 'preset'

const ASSEMBLYAI_API_KEY = "98dd4c7e12d745bc97722b54671ebeff"; 
const ASSEMBLYAI_UPLOAD_URL = "https://api.assemblyai.com/v2/upload";
const ASSEMBLYAI_TRANSCRIPT_URL = "https://api.assemblyai.com/v2/transcript";

const PIXABAY_API_KEY: string = "50577453-acd15cf6b8242af889a9c7b1d"; 
const PIXABAY_URL = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&image_type=photo&orientation=horizontal&safesearch=true&per_page=3`;

const PRESET_BASE_URL = "https://darkslategray-octopus-566678.hostingersite.com/";


const App: React.FC = () => {
  const [inputMode, setInputMode] = useState<InputMode>('file');
  
  const [mainVideoFile, setMainVideoFile] = useState<File | null>(null);
  const [mainVideoUrlInput, setMainVideoUrlInput] = useState<string>("");
  const [mainVideoSrc, setMainVideoSrc] = useState<string | null>(null);
  
  const [transcriptionAudioFile, setTranscriptionAudioFile] = useState<File | null>(null);
  const [transcriptionAudioUrlInput, setTranscriptionAudioUrlInput] = useState<string>("");
  const [presetNumberInput, setPresetNumberInput] = useState<string>(""); // For preset mode

  const mainVideoRef = useRef<HTMLVideoElement>(null);
  const pollingTimeoutRef = useRef<number | null>(null);

  const [scriptSegments, setScriptSegments] = useState<ScriptSegment[]>([]);
  const [isProcessingAI, setIsProcessingAI] = useState(false);
  const [transcriptionStatus, setTranscriptionStatus] = useState("Idle. Configure inputs to start.");

  const [assemblyAiStatus, setAssemblyAiStatus] = useState<'idle' | 'uploading' | 'queued' | 'processing' | 'transcribing' | 'completed' | 'error'>('idle');
  const [assemblyAiTranscriptId, setAssemblyAiTranscriptId] = useState<string | null>(null);

  const [geminiApiKeyExists, setGeminiApiKeyExists] = useState(false);
  const aiRef = useRef<GoogleGenAI | null>(null);

  const [contextualImages, setContextualImages] = useState<ContextualImagesState>({});
  const [activeContextualImageSrc, setActiveContextualImageSrc] = useState<string | null>(null);
  
  const [activeSegmentIndex, setActiveSegmentIndex] = useState<number>(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isVideoReadyToPlay, setIsVideoReadyToPlay] = useState(false);


  const [editingUrlForSegmentKey, setEditingUrlForSegmentKey] = useState<number | null>(null);
  const [currentUserInputUrl, setCurrentUserInputUrl] = useState<string>("");
  const [videoDuration, setVideoDuration] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);


  useEffect(() => {
    if (process.env.API_KEY) {
      aiRef.current = new GoogleGenAI({ apiKey: process.env.API_KEY });
      setGeminiApiKeyExists(true);
    } else {
      setGeminiApiKeyExists(false);
      setTranscriptionStatus(prev => {
        const geminiErrorMsg = "Error: Gemini API Key missing. Visual suggestions disabled.";
        if (prev.includes(geminiErrorMsg)) return prev;
        if (prev.startsWith("Idle") || prev.startsWith("Ready")) return geminiErrorMsg;
        return prev.endsWith(".") ? prev + " " + geminiErrorMsg : prev + ". " + geminiErrorMsg;
      });
      console.error("Gemini API_KEY environment variable not set.");
    }
  }, []);

  const allContextualDataProcessed = assemblyAiStatus === 'completed' && !isProcessingAI && scriptSegments.length > 0;

  const isPixabayConfigured = PIXABAY_API_KEY && PIXABAY_API_KEY !== "YOUR_PIXABAY_API_KEY"; 
  
  const isValidPresetNumber = (numStr: string) => /^\d+$/.test(numStr) && parseInt(numStr, 10) > 0;

  const canStartProcessing = 
    ((inputMode === 'file' && !!mainVideoFile) || 
     (inputMode === 'url' && !!mainVideoUrlInput && mainVideoUrlInput.startsWith('http')) ||
     (inputMode === 'preset' && isValidPresetNumber(presetNumberInput) && !!mainVideoSrc) // Ensure mainVideoSrc is set for preset
    ) &&
    !isProcessingAI && 
    !!ASSEMBLYAI_API_KEY && 
    geminiApiKeyExists &&
    isPixabayConfigured;

  const canStartPlayback = !!mainVideoSrc && allContextualDataProcessed && isVideoReadyToPlay;

  useEffect(() => {
    if (!assemblyAiTranscriptId || assemblyAiStatus === 'completed' || assemblyAiStatus === 'error' || assemblyAiStatus === 'idle') {
      if (pollingTimeoutRef.current) clearTimeout(pollingTimeoutRef.current);
      return;
    }

    const pollAssemblyAI = async () => {
      if (!assemblyAiTranscriptId) return;
      setTranscriptionStatus(`AssemblyAI: Checking status (ID: ${assemblyAiTranscriptId.substring(0,8)}...)`);
      try {
        const response = await fetch(`${ASSEMBLYAI_TRANSCRIPT_URL}/${assemblyAiTranscriptId}`, {
          headers: { authorization: ASSEMBLYAI_API_KEY }
        });
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(`AssemblyAI polling failed: ${response.status} - ${errorData.error || 'Unknown error'}`);
        }
        const data = await response.json();
        setAssemblyAiStatus(data.status as typeof assemblyAiStatus); 

        if (data.status === 'completed') {
          setTranscriptionStatus('AssemblyAI: Transcription complete. Processing visuals...');
          if (data.words && data.words.length > 0) {
            const sentences = segmentTranscriptToSentences(data.words);
            setScriptSegments(sentences);
            processSentencesForVisuals(sentences); 
          } else {
            setTranscriptionStatus('AssemblyAI: Transcription complete but no words found.');
            setScriptSegments([]);
            setIsProcessingAI(false);
          }
        } else if (data.status === 'error') {
          setTranscriptionStatus(`AssemblyAI Error: ${data.error || 'Unknown transcription error'}`);
          setIsProcessingAI(false);
        } else { 
          setTranscriptionStatus(`AssemblyAI: Status - ${data.status}. Will check again...`);
          pollingTimeoutRef.current = window.setTimeout(pollAssemblyAI, 7000); 
        }
      } catch (error: any) {
        console.error("AssemblyAI polling error:", error);
        setTranscriptionStatus(`AssemblyAI polling error: ${error.message}`);
        setAssemblyAiStatus('error');
        setIsProcessingAI(false);
      }
    };

    if (assemblyAiStatus === 'queued' || assemblyAiStatus === 'processing' || assemblyAiStatus === 'transcribing') {
        pollingTimeoutRef.current = window.setTimeout(pollAssemblyAI, 3000); 
    }
    
    return () => {
        if (pollingTimeoutRef.current) clearTimeout(pollingTimeoutRef.current);
    };
  }, [assemblyAiTranscriptId, assemblyAiStatus]);


  useEffect(() => {
    let newSrc: string | null = null;
    if (isPlaying && activeSegmentIndex >= 0 && activeSegmentIndex < scriptSegments.length) {
      const imageInfo = contextualImages[activeSegmentIndex];
      newSrc = imageInfo?.displayUrl || null;
    }
    if (newSrc !== activeContextualImageSrc) {
        setActiveContextualImageSrc(newSrc);
    }
  }, [isPlaying, activeSegmentIndex, scriptSegments, contextualImages, activeContextualImageSrc]);

  const buildInitialStatus = () => {
    let statusParts: string[] = [];
    if (!ASSEMBLYAI_API_KEY) statusParts.push("Error: AssemblyAI API Key missing.");
    if (!geminiApiKeyExists) statusParts.push("Error: Gemini API Key missing. Visuals disabled.");
    if (!isPixabayConfigured) statusParts.push("Error: Pixabay API Key missing or invalid. Image fetching disabled.");

    if (statusParts.length > 0) return statusParts.join(" Also, ");
    
    if ((inputMode === 'file' && mainVideoFile) || 
        (inputMode === 'url' && mainVideoUrlInput) ||
        (inputMode === 'preset' && isValidPresetNumber(presetNumberInput))) {
      return "Ready to process inputs.";
    }
    return "Idle. Configure inputs to start.";
  }

  const handleInputModeChange = (newMode: InputMode) => {
    setInputMode(newMode);
    // Clear inputs of the other mode to avoid confusion
    if (newMode === 'url') {
      setMainVideoFile(null);
      setTranscriptionAudioFile(null);
      setPresetNumberInput("");
    } else if (newMode === 'file') {
      setMainVideoUrlInput("");
      setTranscriptionAudioUrlInput("");
      setPresetNumberInput("");
      if (mainVideoSrc && !mainVideoSrc.startsWith('blob:')) { 
          setMainVideoSrc(null);
      }
    } else { // preset mode
      setMainVideoFile(null);
      setTranscriptionAudioFile(null);
      setMainVideoUrlInput("");
      setTranscriptionAudioUrlInput("");
      // Don't clear presetNumberInput here, let handlePresetNumberChange manage it
      if (presetNumberInput && isValidPresetNumber(presetNumberInput)) {
        setMainVideoSrc(`${PRESET_BASE_URL}${presetNumberInput}.mp4`);
        setIsVideoReadyToPlay(false);
      } else {
        setMainVideoSrc(null);
      }
    }
    setTranscriptionStatus(buildInitialStatus());
  };

  const handleMainVideoUpload = (file: File) => {
    setMainVideoFile(file);
    if (mainVideoSrc && mainVideoSrc.startsWith('blob:')) URL.revokeObjectURL(mainVideoSrc);
    setMainVideoSrc(URL.createObjectURL(file));
    setIsVideoReadyToPlay(false);
    
    let baseStatus = buildInitialStatus();
     if (baseStatus.startsWith("Idle.") && file) { 
        baseStatus = "Ready to process video.";
    }

    if (file.type === "application/octet-stream" || !file.type) {
        const videoWarning = "Warning: Main video file type is generic or undetermined. AssemblyAI might struggle with its audio if a separate audio file isn't provided. Visual playback might also be affected.";
        if (baseStatus.includes("Error:")) {
            baseStatus = baseStatus.endsWith(".") ? baseStatus + " " + videoWarning : baseStatus + ". " + videoWarning;
        } else {
            baseStatus = baseStatus.endsWith(".") ? baseStatus + " " + videoWarning : (baseStatus ? baseStatus + ". " + videoWarning : videoWarning);
        }
    }
    setTranscriptionStatus(baseStatus);
    setIsPlaying(false); setCurrentTime(0); setVideoDuration(0); setActiveSegmentIndex(-1);
  };
  
  const handleTranscriptionAudioUpload = (file: File) => {
    setTranscriptionAudioFile(file);
    setTranscriptionStatus(prevStatus => {
      const audioMsg = "Optional audio for transcription uploaded.";
      if (prevStatus.includes(audioMsg)) return prevStatus; 
      if (prevStatus.startsWith("Idle.") || (inputMode === 'file' && !mainVideoFile) || (inputMode === 'url' && !mainVideoUrlInput)) {
        return audioMsg + " Provide main video input to proceed.";
      }
      return prevStatus.endsWith(".") ? prevStatus + " " + audioMsg : prevStatus + ". " + audioMsg;
    });
  };

  const handleMainVideoUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const url = e.target.value;
    setMainVideoUrlInput(url);
    if (url && (url.startsWith('http://') || url.startsWith('https://')) && url.toLowerCase().endsWith('.mp4')) {
        setMainVideoSrc(url);
        setIsVideoReadyToPlay(false); 
        setTranscriptionStatus("Main video URL set. Ready to process if other configurations are valid.");
        setIsPlaying(false); setCurrentTime(0); setVideoDuration(0); setActiveSegmentIndex(-1);
    } else if (!url) {
        setMainVideoSrc(null);
        setTranscriptionStatus("Main video URL cleared.");
    } else {
        setMainVideoSrc(null);
        setTranscriptionStatus("Invalid or incomplete main video URL. Must be .mp4 and start with http/https.");
    }
  };

  const handleTranscriptionAudioUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const url = e.target.value;
    setTranscriptionAudioUrlInput(url);
     if (url && (url.startsWith('http://') || url.startsWith('https://')) && url.toLowerCase().endsWith('.mp3')) {
        setTranscriptionStatus(prev => prev + " Optional audio URL set.");
    } else if (url && !((url.startsWith('http://') || url.startsWith('https://')) && url.toLowerCase().endsWith('.mp3'))) {
        setTranscriptionStatus(prev => prev + " Warning: Optional audio URL seems invalid (must be .mp3 and start with http/https).");
    }
  };
  
  const handlePresetNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const numStr = e.target.value;
    setPresetNumberInput(numStr);
    if (isValidPresetNumber(numStr)) {
        setMainVideoSrc(`${PRESET_BASE_URL}${numStr}.mp4`);
        setIsVideoReadyToPlay(false);
        setTranscriptionStatus(`Preset ${numStr} selected. Video: ${numStr}.mp4, Audio: ${numStr}.mp3. Ready to process.`);
        setIsPlaying(false); setCurrentTime(0); setVideoDuration(0); setActiveSegmentIndex(-1);
    } else if (!numStr) {
        setMainVideoSrc(null);
        setTranscriptionStatus("Preset number cleared.");
    } else {
        setMainVideoSrc(null);
        setTranscriptionStatus("Invalid preset number. Must be a positive integer.");
    }
  };


  const resetAIStates = useCallback(() => {
    setScriptSegments([]);
    setContextualImages({});
    setActiveContextualImageSrc(null);
    setTranscriptionAudioFile(null); 
    setTranscriptionAudioUrlInput("");
    setPresetNumberInput("");
    // setMainVideoFile(null); // Keep main video if user just wants to re-process
    // setMainVideoUrlInput("");
    // if (inputMode !== 'preset') setMainVideoSrc(null); // Keep mainVideoSrc if it was from preset and still valid

    setTranscriptionStatus(buildInitialStatus());

    setIsProcessingAI(false);
    setActiveSegmentIndex(-1);
    setEditingUrlForSegmentKey(null);
    setCurrentUserInputUrl("");
    setAssemblyAiStatus('idle');
    setAssemblyAiTranscriptId(null);
    if (pollingTimeoutRef.current) clearTimeout(pollingTimeoutRef.current);
    setIsPlaying(false);
    setCurrentTime(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geminiApiKeyExists, inputMode, mainVideoFile, mainVideoUrlInput, isPixabayConfigured, presetNumberInput]); 
  
  useEffect(() => {
    resetAIStates();
  }, [resetAIStates]); 


  const handleStartEditUserUrl = (segmentIndex: number) => {
    setEditingUrlForSegmentKey(segmentIndex);
    const currentImageInfo = contextualImages[segmentIndex];
    setCurrentUserInputUrl(currentImageInfo?.userOverriddenUrl || currentImageInfo?.pixabayUrl || "");
  };

  const handleSaveUserUrl = (segmentIndex: number) => {
    setContextualImages(prev => {
      const updated = { ...prev };
      const existingItem = prev[segmentIndex];
      const newDisplayUrl = currentUserInputUrl.trim() || existingItem?.pixabayUrl || null;
      updated[segmentIndex] = {
        pixabayUrl: existingItem?.pixabayUrl || null,
        userOverriddenUrl: currentUserInputUrl.trim() || null,
        displayUrl: newDisplayUrl,
      };
      if (activeSegmentIndex === segmentIndex && isPlaying) {
        setActiveContextualImageSrc(newDisplayUrl);
      }
      return updated;
    });
    setEditingUrlForSegmentKey(null);
    setCurrentUserInputUrl("");
  };

  const handleCancelEditUserUrl = () => {
    setEditingUrlForSegmentKey(null);
    setCurrentUserInputUrl("");
  };

  const getVisualSuggestionForSentence = async (sentence: string, ai: GoogleGenAI): Promise<string | null> => {
    if (!sentence.trim() || !geminiApiKeyExists || !ai) return null;
    try {
      const prompt = `Analyze this sentence: '${sentence}'. Identify the most prominent visual keyword or short phrase (2-3 words max) suitable for an image search query. Focus on concrete nouns or distinct concepts. If the sentence is too abstract or no clear visual emerges, return null. Respond ONLY with a JSON object containing a single key "suggestion", whose value is either the identified string or null.`;
      
      const response: GenerateContentResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-04-17', contents: prompt, config: { responseMimeType: "application/json" },
      });
      let jsonStr = response.text.trim();
      const fenceRegex = /^```(\w*)?\s*\n?(.*?)\n?\s*```$/s;
      const match = jsonStr.match(fenceRegex);
      if (match && match[2]) jsonStr = match[2].trim();
      const parsedData = JSON.parse(jsonStr);
      return parsedData.suggestion || null;
    } catch (error) { console.error(`Gemini suggestion error:`, error); return null; }
  };
  
  const fetchImageFromPixabay = async (query: string): Promise<string | null> => {
    if (!query || !isPixabayConfigured) return null;
    try {
      const response = await fetch(`${PIXABAY_URL}&q=${encodeURIComponent(query)}`);
      if (!response.ok) {
        console.error(`Pixabay API error: ${response.status}`);
        return null;
      }
      const data = await response.json();
      if (data.hits && data.hits.length > 0) {
        return data.hits[0].webformatURL; 
      }
      return null;
    } catch (error) {
      console.error(`Error fetching image from Pixabay:`, error);
      return null;
    }
  };

  const segmentTranscriptToSentences = (assemblyWords: AssemblyAIWord[]): ScriptSegment[] => {
    const segments: ScriptSegment[] = [];
    if (!assemblyWords || assemblyWords.length === 0) return segments;

    let currentSentenceText = "";
    let currentSentenceWords: AssemblyAIWord[] = [];
    let sentenceStartTime = assemblyWords[0].start / 1000;

    for (let i = 0; i < assemblyWords.length; i++) {
        const word = assemblyWords[i];
        currentSentenceText += word.text + " ";
        currentSentenceWords.push(word);

        const isLastWord = i === assemblyWords.length - 1;
        const endsWithPunctuation = /[.!?]$/.test(word.text.trim());
        const nextWordStartsNewThought = (i + 1 < assemblyWords.length) && (assemblyWords[i+1].start - word.end > 700); 

        if (endsWithPunctuation || isLastWord || nextWordStartsNewThought) {
            segments.push({
                text: currentSentenceText.trim(),
                startTime: sentenceStartTime,
                endTime: word.end / 1000,
                words: [...currentSentenceWords],
                pixabayFetchStatus: 'idle',
            });
            currentSentenceText = "";
            currentSentenceWords = [];
            if (i + 1 < assemblyWords.length) {
                sentenceStartTime = assemblyWords[i+1].start / 1000;
            }
        }
    }
    return segments;
  };

  const processSentencesForVisuals = async (sentences: ScriptSegment[]) => {
    if (!aiRef.current || !geminiApiKeyExists) {
        setTranscriptionStatus(prev => prev + " Cannot process visuals: Gemini AI not available for suggestions.");
        setIsProcessingAI(false);
        return;
    }
    if (!isPixabayConfigured) {
        setTranscriptionStatus(prev => prev + " Cannot fetch images: Pixabay API Key missing or invalid.");
        setIsProcessingAI(false);
        return;
    }

    setTranscriptionStatus("Generating visual suggestions for Pixabay...");
    const updatedSegments = [...sentences];
    let newContextualImages: ContextualImagesState = {};

    for (let i = 0; i < updatedSegments.length; i++) {
      if (!updatedSegments[i].text.trim()) {
        updatedSegments[i].pixabayFetchStatus = 'no_image_found'; 
        updatedSegments[i].visualQueryForPixabay = null;
        newContextualImages[i] = null;
        continue;
      }
      
      setTranscriptionStatus(`Visuals: Suggesting for segment ${i + 1}/${updatedSegments.length}...`);
      updatedSegments[i].pixabayFetchStatus = 'suggesting';
      setScriptSegments([...updatedSegments]); 

      const suggestion = await getVisualSuggestionForSentence(updatedSegments[i].text, aiRef.current);
      updatedSegments[i].visualQueryForPixabay = suggestion;

      if (suggestion) {
        setTranscriptionStatus(`Visuals: Fetching image from Pixabay for segment ${i + 1} ('${suggestion}')...`);
        updatedSegments[i].pixabayFetchStatus = 'fetching';
        setScriptSegments([...updatedSegments]);

        const imageUrl = await fetchImageFromPixabay(suggestion);
        if (imageUrl) {
          updatedSegments[i].pixabayFetchStatus = 'fetched';
          newContextualImages[i] = { pixabayUrl: imageUrl, userOverriddenUrl: null, displayUrl: imageUrl };
        } else {
          updatedSegments[i].pixabayFetchStatus = 'failed_fetch'; 
          newContextualImages[i] = null;
        }
      } else {
        updatedSegments[i].pixabayFetchStatus = 'no_image_found';
        newContextualImages[i] = null;
      }
      setScriptSegments([...updatedSegments]); 
      setContextualImages(prev => ({...prev, ...newContextualImages})); 
    }
    setContextualImages(newContextualImages); 
    setTranscriptionStatus("Visual processing complete.");
    setIsProcessingAI(false);
  };
  
  const handleTranscribeAndProcessSentences = async () => {
    if (inputMode === 'file' && !mainVideoFile) { 
      setTranscriptionStatus("Error: Main video file is missing."); return;
    }
    if (inputMode === 'url' && (!mainVideoUrlInput || !mainVideoUrlInput.startsWith('http'))) {
      setTranscriptionStatus("Error: Main video URL is missing or invalid."); return;
    }
    if (inputMode === 'preset' && (!presetNumberInput || !isValidPresetNumber(presetNumberInput))) {
      setTranscriptionStatus("Error: Preset number is missing or invalid."); return;
    }
    if (!ASSEMBLYAI_API_KEY) {
      setTranscriptionStatus("Error: AssemblyAI API Key missing."); return;
    }
    if (!geminiApiKeyExists || !aiRef.current) {
      setTranscriptionStatus("Error: Gemini API Key missing. Cannot proceed with visual suggestions."); return;
    }
    if (!isPixabayConfigured) {
      setTranscriptionStatus("Error: Pixabay API Key missing or invalid. Cannot fetch images."); return;
    }

    setIsProcessingAI(true);
    setScriptSegments([]);
    setContextualImages({});
    setActiveContextualImageSrc(null);
    setActiveSegmentIndex(-1);
    setEditingUrlForSegmentKey(null);
    setCurrentUserInputUrl("");
    setAssemblyAiStatus('idle');
    setAssemblyAiTranscriptId(null);
    if (pollingTimeoutRef.current) clearTimeout(pollingTimeoutRef.current);
    
    let audio_url_for_transcription: string | null = null;
    let operationDescription = "";

    try {
      if (inputMode === 'file') {
        const fileToTranscribe = transcriptionAudioFile || mainVideoFile;
        if (!fileToTranscribe) { throw new Error("No file available for transcription."); }
        operationDescription = `AssemblyAI: Uploading ${transcriptionAudioFile ? 'custom audio file' : 'main video file'}...`;
        setTranscriptionStatus(operationDescription);
        setAssemblyAiStatus('uploading');

        const formData = new FormData();
        formData.append('file', fileToTranscribe);
        const uploadResponse = await fetch(ASSEMBLYAI_UPLOAD_URL, {
          method: 'POST',
          headers: { authorization: ASSEMBLYAI_API_KEY },
          body: formData,
        });
        if (!uploadResponse.ok) {
          const errorData = await uploadResponse.json();
          throw new Error(`AssemblyAI Upload Failed: ${uploadResponse.status} - ${errorData.error || 'Unknown upload error'}`);
        }
        const uploadData = await uploadResponse.json();
        audio_url_for_transcription = uploadData.upload_url;
        if (!audio_url_for_transcription) throw new Error("AssemblyAI Upload Error: No upload_url received.");
        operationDescription = `AssemblyAI: ${transcriptionAudioFile ? 'Custom audio file' : 'Video file audio'} uploaded. Submitting for transcription...`;
      
      } else if (inputMode === 'url') {
        if (transcriptionAudioUrlInput && transcriptionAudioUrlInput.startsWith('http')) {
          audio_url_for_transcription = transcriptionAudioUrlInput;
          operationDescription = `AssemblyAI: Using custom audio URL for transcription...`;
        } else if (mainVideoUrlInput && mainVideoUrlInput.startsWith('http')) {
          audio_url_for_transcription = mainVideoUrlInput;
          operationDescription = `AssemblyAI: Using main video URL for transcription...`;
        } else {
          throw new Error("No valid URL available for transcription.");
        }
      } else { // inputMode === 'preset'
        if (presetNumberInput && isValidPresetNumber(presetNumberInput)) {
          audio_url_for_transcription = `${PRESET_BASE_URL}${presetNumberInput}.mp3`;
          operationDescription = `AssemblyAI: Using preset audio URL ${presetNumberInput}.mp3 for transcription...`;
        } else {
          throw new Error("No valid preset number for transcription.");
        }
      }


      setTranscriptionStatus(operationDescription);
      const transcriptResponse = await fetch(ASSEMBLYAI_TRANSCRIPT_URL, {
        method: 'POST',
        headers: {
          authorization: ASSEMBLYAI_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ audio_url: audio_url_for_transcription }),
      });

      if (!transcriptResponse.ok) {
        const errorData = await transcriptResponse.json();
        throw new Error(`AssemblyAI Transcription Submit Failed: ${transcriptResponse.status} - ${errorData.error || 'Unknown submission error'}`);
      }
      const transcriptData = await transcriptResponse.json();
      setAssemblyAiTranscriptId(transcriptData.id);
      setAssemblyAiStatus(transcriptData.status as typeof assemblyAiStatus); 
      setTranscriptionStatus(`AssemblyAI: Transcription submitted (ID: ${transcriptData.id.substring(0,8)}...). Status: ${transcriptData.status}`);

    } catch (error: any) {
      console.error("Transcription process error:", error);
      setTranscriptionStatus(`Error: ${error.message}`);
      setIsProcessingAI(false);
      setAssemblyAiStatus('error');
    }
  };

  const handlePlayPause = () => {
    if (!mainVideoRef.current || !allContextualDataProcessed || !isVideoReadyToPlay) return;
    if (isPlaying) {
      mainVideoRef.current.pause();
    } else {
      mainVideoRef.current.play().catch(error => {
        console.error("Error playing video:", error);
        setTranscriptionStatus(`Playback Error: ${error.message}. Ensure you've interacted with the page.`);
        setIsPlaying(false);
      });
    }
  };
  
  const handleReplay = () => {
    if (mainVideoRef.current && isVideoReadyToPlay) {
        mainVideoRef.current.currentTime = 0;
        mainVideoRef.current.play().catch(error => {
            console.error("Error replaying video:", error);
            setTranscriptionStatus(`Playback Error: ${error.message}.`);
            setIsPlaying(false);
        });
    }
  };

  const handleResetPlayback = () => {
    if (mainVideoRef.current) {
        mainVideoRef.current.pause();
        mainVideoRef.current.currentTime = 0;
        setIsPlaying(false);
        setCurrentTime(0);
        setActiveSegmentIndex(-1);
        setActiveContextualImageSrc(null);
    }
  };

  const handleTimeUpdate = useCallback(() => {
    if (!mainVideoRef.current) return;
    const newTime = mainVideoRef.current.currentTime;
    setCurrentTime(newTime);
    const currentSegmentIdx = scriptSegments.findIndex(segment => newTime >= segment.startTime && newTime < segment.endTime);
    
    if (currentSegmentIdx !== activeSegmentIndex) {
        setActiveSegmentIndex(currentSegmentIdx);
    }
  }, [scriptSegments, activeSegmentIndex]);

  const handleSeek = (time: number) => {
    if (mainVideoRef.current && allContextualDataProcessed && isVideoReadyToPlay) {
        mainVideoRef.current.currentTime = time;
        const currentSegmentIdx = scriptSegments.findIndex(segment => time >= segment.startTime && time < segment.endTime);
        if (currentSegmentIdx !== activeSegmentIndex) {
            setActiveSegmentIndex(currentSegmentIdx);
        }
    }
  };

  useEffect(() => {
    const videoNode = mainVideoRef.current;
    if (videoNode) {
      const onPlay = () => setIsPlaying(true);
      const onPause = () => setIsPlaying(false);
      const onEnded = () => {
        setIsPlaying(false);
      };
      const onLoadedMeta = () => {
        setVideoDuration(videoNode.duration);
        setCurrentTime(videoNode.currentTime); 
      };
      const onCanPlayThrough = () => setIsVideoReadyToPlay(true);
      const onWaiting = () => setIsVideoReadyToPlay(false); 
      const onPlaying = () => setIsVideoReadyToPlay(true); 

      videoNode.addEventListener('play', onPlay);
      videoNode.addEventListener('pause', onPause);
      videoNode.addEventListener('ended', onEnded);
      videoNode.addEventListener('timeupdate', handleTimeUpdate);
      videoNode.addEventListener('loadedmetadata', onLoadedMeta);
      videoNode.addEventListener('canplaythrough', onCanPlayThrough);
      videoNode.addEventListener('waiting', onWaiting);
      videoNode.addEventListener('playing', onPlaying);
      
      if (videoNode.readyState >= 1) onLoadedMeta();
      if (videoNode.readyState >= 4) onCanPlayThrough(); 

      return () => {
        videoNode.removeEventListener('play', onPlay);
        videoNode.removeEventListener('pause', onPause);
        videoNode.removeEventListener('ended', onEnded);
        videoNode.removeEventListener('timeupdate', handleTimeUpdate);
        videoNode.removeEventListener('loadedmetadata', onLoadedMeta);
        videoNode.removeEventListener('canplaythrough', onCanPlayThrough);
        videoNode.removeEventListener('waiting', onWaiting);
        videoNode.removeEventListener('playing', onPlaying);
      };
    }
  }, [mainVideoSrc, handleTimeUpdate]); 


  const formatTime = (seconds: number): string => {
    if (isNaN(seconds) || seconds < 0) return "0:00";
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
  };


  return (
    <div className="min-h-screen bg-gray-800 text-gray-100 flex flex-col items-center p-4 selection:bg-purple-500 selection:text-white">
      <header className="w-full max-w-5xl mb-6 text-center">
        <h1 className="text-4xl font-bold text-purple-400">Ladki AI Video Visualizer</h1>
        <p className="text-gray-400 mt-1">Provide video/audio by file upload, URL, or preset number, get transcription, and see AI-suggested contextual images from Pixabay.</p>
      </header>

      {!geminiApiKeyExists && (
          <div className="w-full max-w-3xl p-4 mb-4 bg-red-800 text-red-100 border border-red-600 rounded-md text-center">
              <strong>Critical Error:</strong> Gemini API Key (process.env.API_KEY) is not set. Visual suggestions will not function. Please set this environment variable.
          </div>
      )}
      {!isPixabayConfigured && PIXABAY_API_KEY === "50577453-acd15cf6b8242af889a9c7b1d" && ( 
          <div className="w-full max-w-3xl p-4 mb-4 bg-yellow-700 text-yellow-100 border border-yellow-600 rounded-md text-center">
              <strong>Configuration Note:</strong> The Pixabay API Key has been updated with the one you provided. Ensure it's active and has sufficient quota.
          </div>
      )}
       {!isPixabayConfigured && PIXABAY_API_KEY !== "50577453-acd15cf6b8242af889a9c7b1d" && ( 
          <div className="w-full max-w-3xl p-4 mb-4 bg-red-800 text-red-100 border border-red-600 rounded-md text-center">
              <strong>Critical Error:</strong> Pixabay API Key is not set or is invalid in the code. Image fetching will not function. Please update <code>App.tsx</code>.
          </div>
      )}
      {!ASSEMBLYAI_API_KEY && (
          <div className="w-full max-w-3xl p-4 mb-4 bg-red-800 text-red-100 border border-red-600 rounded-md text-center">
              <strong>Critical Error:</strong> AssemblyAI API Key is not set in the code. Transcription will not function.
          </div>
      )}


      <main className="w-full max-w-5xl flex flex-col md:flex-row gap-6">
        <div className="md:w-1/3 space-y-4 bg-gray-700 p-4 rounded-lg shadow-xl">
          <h2 className="text-xl font-semibold text-purple-300 border-b border-purple-400 pb-2">1. Input Configuration</h2>
          
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-300">Input Source:</label>
            <div className="flex items-center space-x-3">
              <label className="flex items-center space-x-1 cursor-pointer">
                <input type="radio" name="inputMode" value="file" checked={inputMode === 'file'} onChange={() => handleInputModeChange('file')} className="form-radio text-purple-500 bg-gray-800 border-gray-600 focus:ring-purple-500"/>
                <span className="text-sm">Upload Files</span>
              </label>
              <label className="flex items-center space-x-1 cursor-pointer">
                <input type="radio" name="inputMode" value="url" checked={inputMode === 'url'} onChange={() => handleInputModeChange('url')} className="form-radio text-purple-500 bg-gray-800 border-gray-600 focus:ring-purple-500"/>
                <span className="text-sm">Use URLs</span>
              </label>
              <label className="flex items-center space-x-1 cursor-pointer">
                <input type="radio" name="inputMode" value="preset" checked={inputMode === 'preset'} onChange={() => handleInputModeChange('preset')} className="form-radio text-purple-500 bg-gray-800 border-gray-600 focus:ring-purple-500"/>
                <span className="text-sm">Use Preset</span>
              </label>
            </div>
          </div>

          {inputMode === 'file' && (
            <div className="space-y-3 pt-2 border-t border-gray-600">
              <FileUpload
                label="Main Video File"
                onFileUpload={handleMainVideoUpload}
                accept="video/*"
                currentFile={mainVideoFile}
                isRequired={true}
              />
              <FileUpload
                label="Audio for Transcription (Optional)"
                onFileUpload={handleTranscriptionAudioUpload}
                accept="audio/*"
                currentFile={transcriptionAudioFile}
                isRequired={false}
              />
            </div>
          )}

          {inputMode === 'url' && (
            <div className="space-y-3 pt-2 border-t border-gray-600">
              <div>
                <label htmlFor="mainVideoUrl" className="block text-sm font-medium text-gray-300 mb-1">Main Video URL (.mp4)</label>
                <input type="url" id="mainVideoUrl" value={mainVideoUrlInput} onChange={handleMainVideoUrlChange} placeholder="https://example.com/video.mp4"
                       className="w-full p-2 text-sm bg-gray-800 text-gray-200 border border-gray-600 rounded-md focus:ring-1 focus:ring-purple-500 focus:border-purple-500" />
              </div>
              <div>
                <label htmlFor="transcriptionAudioUrl" className="block text-sm font-medium text-gray-300 mb-1">Audio URL for Transcription (Optional, .mp3)</label>
                <input type="url" id="transcriptionAudioUrl" value={transcriptionAudioUrlInput} onChange={handleTranscriptionAudioUrlChange} placeholder="https://example.com/audio.mp3"
                       className="w-full p-2 text-sm bg-gray-800 text-gray-200 border border-gray-600 rounded-md focus:ring-1 focus:ring-purple-500 focus:border-purple-500" />
              </div>
            </div>
          )}

          {inputMode === 'preset' && (
             <div className="space-y-3 pt-2 border-t border-gray-600">
              <div>
                <label htmlFor="presetNumber" className="block text-sm font-medium text-gray-300 mb-1">Preset Number (e.g., 1, 2)</label>
                <input type="text" id="presetNumber" value={presetNumberInput} onChange={handlePresetNumberChange} placeholder="Enter a number"
                       className="w-full p-2 text-sm bg-gray-800 text-gray-200 border border-gray-600 rounded-md focus:ring-1 focus:ring-purple-500 focus:border-purple-500" />
                {presetNumberInput && isValidPresetNumber(presetNumberInput) && (
                  <p className="text-xs text-gray-400 mt-1">
                    Using: Video: <code>{PRESET_BASE_URL}{presetNumberInput}.mp4</code>, Audio: <code>{PRESET_BASE_URL}{presetNumberInput}.mp3</code>
                  </p>
                )}
              </div>
            </div>
          )}
          
          <button
            onClick={handleTranscribeAndProcessSentences}
            disabled={!canStartProcessing || isProcessingAI}
            className={`w-full px-4 py-2 text-base font-semibold rounded-md transition-all duration-150 ease-in-out mt-3
                        ${canStartProcessing && !isProcessingAI ? 'bg-green-600 hover:bg-green-700 text-white' : 'bg-gray-500 text-gray-400 cursor-not-allowed'}`}
            aria-live="polite"
          >
            {isProcessingAI ? 'Processing AI...' : '2. Process Inputs & Visuals'}
          </button>
          <div className="text-xs text-gray-400 p-2 bg-gray-800 rounded min-h-[50px] overflow-y-auto max-h-[150px]">
            Status: <span className="font-medium text-gray-300">{transcriptionStatus}</span>
          </div>
        </div>

        <div className="md:w-2/3 flex flex-col items-center">
          <VideoStage 
            ref={mainVideoRef}
            mainVideoSrc={mainVideoSrc}
            contextualImageSrc={activeContextualImageSrc}
            isPlaying={isPlaying}
            isVideoBuffering={mainVideoSrc !== null && !isVideoReadyToPlay}
          />
          {mainVideoSrc && (
            <div className="mt-4 w-full max-w-sm md:max-w-md space-y-2">
                <div className="flex space-x-2">
                    <button 
                        onClick={handlePlayPause}
                        disabled={!canStartPlayback}
                        className={`flex-1 px-4 py-2 font-semibold rounded-md transition-colors duration-150
                                    ${canStartPlayback ? (isPlaying ? 'bg-yellow-600 hover:bg-yellow-700' : 'bg-purple-600 hover:bg-purple-700') + ' text-white' : 'bg-gray-500 text-gray-400 cursor-not-allowed'}`}
                    >
                        {isPlaying ? 'Pause' : 'Play'}
                    </button>
                    <button
                        onClick={handleReplay}
                        disabled={!mainVideoSrc || !isVideoReadyToPlay} 
                        className={`flex-1 px-4 py-2 font-semibold rounded-md transition-colors duration-150 ${(mainVideoSrc && isVideoReadyToPlay) ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-gray-500 text-gray-400 cursor-not-allowed'}`}
                    >
                        Replay
                    </button>
                     <button
                        onClick={handleResetPlayback}
                        disabled={!mainVideoSrc} 
                        className={`flex-1 px-4 py-2 font-semibold rounded-md transition-colors duration-150 ${mainVideoSrc ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-gray-500 text-gray-400 cursor-not-allowed'}`}
                    >
                        Reset Video
                    </button>
                </div>
                {videoDuration > 0 && (
                  <div className="text-center text-sm text-gray-400">
                    {formatTime(currentTime)} / {formatTime(videoDuration)}
                  </div>
                )}
            </div>
          )}
        </div>
      </main>

      {scriptSegments.length > 0 && (
        <section className="w-full max-w-5xl mt-8 p-4 bg-gray-700 rounded-lg shadow-xl">
          <h2 className="text-xl font-semibold text-purple-300 border-b border-purple-400 pb-2 mb-3">Timeline & Visuals</h2>
          <div className="max-h-[400px] overflow-y-auto space-y-3 pr-2">
            {scriptSegments.map((segment, index) => (
              <div key={index} 
                   className={`p-3 rounded-md transition-all duration-200 ease-in-out border-l-4
                               ${activeSegmentIndex === index && isPlaying ? 'bg-purple-700 border-purple-300 shadow-lg' : 'bg-gray-600 border-gray-500 hover:bg-gray-500'}
                               ${allContextualDataProcessed && isVideoReadyToPlay ? 'cursor-pointer' : 'cursor-default'}`}
                   onClick={() => allContextualDataProcessed && isVideoReadyToPlay && handleSeek(segment.startTime)}
              >
                <p className="text-xs text-gray-400">
                  Time: {formatTime(segment.startTime)} - {formatTime(segment.endTime)}
                </p>
                <p className={`font-medium ${activeSegmentIndex === index && isPlaying ? 'text-white' : 'text-gray-200'}`}>{segment.text}</p>
                
                <div className="mt-2 text-xs">
                    {segment.pixabayFetchStatus === 'suggesting' && <p className="text-yellow-400">Suggesting visual query...</p>}
                    {segment.pixabayFetchStatus === 'fetching' && <p className="text-yellow-400">Fetching image from Pixabay for: "{segment.visualQueryForPixabay}"</p>}
                    {segment.pixabayFetchStatus === 'fetched' && segment.visualQueryForPixabay && <p className="text-green-400">Fetched from Pixabay for: "{segment.visualQueryForPixabay}"</p>}
                    {segment.pixabayFetchStatus === 'failed_suggestion' && <p className="text-red-400">Failed to get suggestion for Pixabay.</p>}
                    {segment.pixabayFetchStatus === 'failed_fetch' && <p className="text-red-400">Failed to fetch image from Pixabay for: "{segment.visualQueryForPixabay}"</p>}
                    {segment.pixabayFetchStatus === 'no_image_found' && (!segment.text.trim() || segment.text.split(" ").length < 2) && <p className="text-gray-500 italic">Segment too short for visual.</p>}
                    {segment.pixabayFetchStatus === 'no_image_found' && segment.visualQueryForPixabay && <p className="text-gray-400">No image found on Pixabay for: "{segment.visualQueryForPixabay}"</p>}
                    {segment.pixabayFetchStatus === 'no_image_found' && !segment.visualQueryForPixabay && segment.text.trim() && segment.text.split(" ").length >= 2 && <p className="text-gray-400">No clear visual suggestion found for Pixabay.</p>}


                    {contextualImages[index]?.displayUrl && (
                        <img src={contextualImages[index]?.displayUrl} alt={`Visual for "${segment.text.substring(0,30)}..."`} className="mt-1 h-16 w-auto rounded border border-gray-500"/>
                    )}
                    
                    {editingUrlForSegmentKey === index ? (
                        <div className="mt-2 flex items-center space-x-2">
                            <input 
                                type="url"
                                value={currentUserInputUrl}
                                onChange={(e) => setCurrentUserInputUrl(e.target.value)}
                                placeholder="Enter image URL (or leave blank for Pixabay)"
                                className="flex-grow p-1 text-xs bg-gray-800 text-gray-200 border border-gray-500 rounded focus:ring-1 focus:ring-purple-500 focus:border-purple-500"
                            />
                            <button onClick={() => handleSaveUserUrl(index)} className="px-2 py-1 text-xs bg-green-600 hover:bg-green-700 rounded">Save</button>
                            <button onClick={handleCancelEditUserUrl} className="px-2 py-1 text-xs bg-red-600 hover:bg-red-700 rounded">Cancel</button>
                        </div>
                    ) : (
                         allContextualDataProcessed && segment.text.trim() && ( 
                            <button 
                                onClick={() => handleStartEditUserUrl(index)}
                                className="mt-2 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 rounded"
                            >
                                {contextualImages[index]?.userOverriddenUrl ? 'Edit URL' : (contextualImages[index]?.pixabayUrl ? 'Override Pixabay Image' : 'Add Custom URL')}
                            </button>
                         )
                    )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};

export default App;
