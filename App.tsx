
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

const ASSEMBLYAI_API_KEY = "98dd4c7e12d745bc97722b54671ebeff"; 
const ASSEMBLYAI_UPLOAD_URL = "https://api.assemblyai.com/v2/upload";
const ASSEMBLYAI_TRANSCRIPT_URL = "https://api.assemblyai.com/v2/transcript";

const PIXABAY_API_KEY = "50577453-acd15cf6b8242af889a9c7b1d"; // <<< IMPORTANT: Replace with your actual Pixabay API Key
const PIXABAY_URL = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&image_type=photo&orientation=horizontal&safesearch=true&per_page=3`;

const App: React.FC = () => {
  const [mainVideoFile, setMainVideoFile] = useState<File | null>(null);
  const [mainVideoSrc, setMainVideoSrc] = useState<string | null>(null);
  const [transcriptionAudioFile, setTranscriptionAudioFile] = useState<File | null>(null);

  const [mainVideoUrlInput, setMainVideoUrlInput] = useState<string>("");
  const [transcriptionAudioUrlInput, setTranscriptionAudioUrlInput] = useState<string>("");
  const [loadedMainVideoUrl, setLoadedMainVideoUrl] = useState<string | null>(null);
  const [loadedTranscriptionAudioUrl, setLoadedTranscriptionAudioUrl] = useState<string | null>(null);

  const mainVideoRef = useRef<HTMLVideoElement>(null);
  const pollingTimeoutRef = useRef<number | null>(null);

  const [scriptSegments, setScriptSegments] = useState<ScriptSegment[]>([]);
  const [isProcessingAI, setIsProcessingAI] = useState(false);
  const [transcriptionStatus, setTranscriptionStatus] = useState("Idle. Use preset, or choose another method to load video/audio.");

  const [assemblyAiStatus, setAssemblyAiStatus] = useState<'idle' | 'uploading' | 'queued' | 'processing' | 'transcribing' | 'completed' | 'error'>('idle');
  const [assemblyAiTranscriptId, setAssemblyAiTranscriptId] = useState<string | null>(null);

  const [geminiApiKeyExists, setGeminiApiKeyExists] = useState(false);
  const aiRef = useRef<GoogleGenAI | null>(null);

  const [contextualImages, setContextualImages] = useState<ContextualImagesState>({});
  const [activeContextualImageSrc, setActiveContextualImageSrc] = useState<string | null>(null);
  
  const [activeSegmentIndex, setActiveSegmentIndex] = useState<number>(-1);
  const [isPlaying, setIsPlaying] = useState(false);

  const [editingUrlForSegmentKey, setEditingUrlForSegmentKey] = useState<number | null>(null);
  const [currentUserInputUrl, setCurrentUserInputUrl] = useState<string>("");
  const [videoDuration, setVideoDuration] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);

  const [presetInput, setPresetInput] = useState<string>("");
  const [isPresetLoading, setIsPresetLoading] = useState<boolean>(false);
  const [currentPresetStatus, setCurrentPresetStatus] = useState<string>("");
  const [loadedPresetId, setLoadedPresetId] = useState<number | null>(null);

  const [activeAlternativeMethod, setActiveAlternativeMethod] = useState<'url' | 'file' | null>(null);


  useEffect(() => {
    if (process.env.API_KEY) {
      aiRef.current = new GoogleGenAI({ apiKey: process.env.API_KEY });
      setGeminiApiKeyExists(true);
    } else {
      setGeminiApiKeyExists(false);
      console.error("Gemini API_KEY environment variable not set.");
    }
  }, []);

  useEffect(() => {
    setTranscriptionStatus(buildInitialStatus());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geminiApiKeyExists, mainVideoSrc, PIXABAY_API_KEY, ASSEMBLYAI_API_KEY, loadedPresetId, loadedMainVideoUrl, mainVideoFile, loadedTranscriptionAudioUrl, activeAlternativeMethod]);


  const allContextualDataProcessed = assemblyAiStatus === 'completed' && !isProcessingAI && scriptSegments.length > 0;
  
  const mainVideoSourceAvailable = !!mainVideoSrc;
  const canStartProcessing = mainVideoSourceAvailable && !isProcessingAI && !!ASSEMBLYAI_API_KEY && geminiApiKeyExists && !!PIXABAY_API_KEY && PIXABAY_API_KEY !== "YOUR_PIXABAY_API_KEY";
  const canStartPlayback = !!mainVideoSrc && allContextualDataProcessed;

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
    if (!PIXABAY_API_KEY || PIXABAY_API_KEY === "YOUR_PIXABAY_API_KEY") statusParts.push("Error: Pixabay API Key missing or invalid. Image fetching disabled.");
    
    if (statusParts.length > 0) return statusParts.join(" Also, ");
    
    if (loadedPresetId !== null && loadedMainVideoUrl && loadedTranscriptionAudioUrl) {
         return `Preset ${loadedPresetId} loaded. Video: .../${loadedPresetId}.mp4, Audio: .../${loadedPresetId}.mp3. Ready to process.`;
    }
    if (mainVideoSrc) {
        if (loadedMainVideoUrl && activeAlternativeMethod === 'url') return `Video URL loaded. Ready to process.`;
        if (mainVideoFile && activeAlternativeMethod === 'file') return "Video file uploaded. Ready to process.";
    }
    if (activeAlternativeMethod === 'url') return "Enter video/audio URLs to load.";
    if (activeAlternativeMethod === 'file') return "Upload video/audio files.";
    return "Idle. Use preset, or choose another method to load video/audio.";
  }

  const resetUIAndAIStatesForNewSource = () => {
    setIsPlaying(false);
    setCurrentTime(0);
    setVideoDuration(0);
    setActiveSegmentIndex(-1);
    setScriptSegments([]);
    setContextualImages({});
    setActiveContextualImageSrc(null);
    setAssemblyAiStatus('idle');
    setAssemblyAiTranscriptId(null);
    setIsProcessingAI(false);
    if (pollingTimeoutRef.current) clearTimeout(pollingTimeoutRef.current);
    setEditingUrlForSegmentKey(null);
    setCurrentUserInputUrl("");
  };


  const handleMainVideoUpload = (file: File) => {
    if (mainVideoSrc && !mainVideoSrc.startsWith('blob:')) URL.revokeObjectURL(mainVideoSrc); 
    
    setMainVideoFile(file);
    setMainVideoSrc(URL.createObjectURL(file));
    
    // Clear other input methods
    setLoadedMainVideoUrl(null); 
    setMainVideoUrlInput("");     
    setLoadedPresetId(null);   
    setPresetInput("");
    setCurrentPresetStatus("");
    setActiveAlternativeMethod('file'); // Explicitly set file as active method
    
    // Clear transcription sources from other methods if main source changes
    setTranscriptionAudioFile(null); // Keep or clear based on UX decision, for now clear if main video changes this way
    setLoadedTranscriptionAudioUrl(null); 
    setTranscriptionAudioUrlInput("");   

    resetUIAndAIStatesForNewSource();
    setTranscriptionStatus(buildInitialStatus());
  };

  const handleLoadMainVideoUrl = () => {
    if (!mainVideoUrlInput.trim()) {
        setTranscriptionStatus("Please enter a valid main video URL.");
        return;
    }
    if (mainVideoSrc && mainVideoSrc.startsWith('blob:')) URL.revokeObjectURL(mainVideoSrc);

    setMainVideoSrc(mainVideoUrlInput.trim());
    setLoadedMainVideoUrl(mainVideoUrlInput.trim());

    // Clear other input methods
    setMainVideoFile(null);    
    setLoadedPresetId(null);   
    setPresetInput("");
    setCurrentPresetStatus("");
    setActiveAlternativeMethod('url'); // Explicitly set URL as active method

    // Clear transcription sources from other methods if main source changes
    setTranscriptionAudioFile(null); // Keep or clear, for now clear
    setLoadedTranscriptionAudioUrl(null);
    setTranscriptionAudioUrlInput("");

    resetUIAndAIStatesForNewSource();
    setTranscriptionStatus(buildInitialStatus());
  };
  
  const handleTranscriptionAudioUpload = (file: File) => {
    setTranscriptionAudioFile(file);
    // Clear other audio sources
    setLoadedTranscriptionAudioUrl(null); 
    setTranscriptionAudioUrlInput("");   
    
    setTranscriptionStatus(prevStatus => {
      const audioMsg = "Optional audio file for transcription uploaded.";
      if (prevStatus.includes(audioMsg)) return prevStatus; 
      if (!mainVideoSrc && activeAlternativeMethod !== 'file') return audioMsg + " Load main video using a selected method to proceed.";
      return prevStatus.endsWith(".") ? prevStatus + " " + audioMsg : prevStatus + ". " + audioMsg;
    });
  };

  const handleLoadTranscriptionAudioUrl = () => {
    if (!transcriptionAudioUrlInput.trim()) {
        setTranscriptionStatus("Please enter a valid transcription audio URL.");
        return;
    }
    setLoadedTranscriptionAudioUrl(transcriptionAudioUrlInput.trim());
    // Clear other audio sources
    setTranscriptionAudioFile(null); 
    
    setTranscriptionStatus(prevStatus => {
      const audioMsg = "Optional audio URL for transcription loaded.";
      if (prevStatus.includes(audioMsg)) return prevStatus;
      if (!mainVideoSrc && activeAlternativeMethod !== 'url') return audioMsg + " Load main video using a selected method to proceed.";
      return prevStatus.endsWith(".") ? prevStatus + " " + audioMsg : prevStatus + ". " + audioMsg;
    });
  };

  const resetAllInputMethods = (except?: 'preset' | 'url' | 'file') => {
    if (except !== 'preset') {
        setPresetInput("");
        setLoadedPresetId(null);
        setCurrentPresetStatus("");
    }
    if (except !== 'url') {
        setMainVideoUrlInput("");
        setTranscriptionAudioUrlInput("");
        setLoadedMainVideoUrl(null);
        // setLoadedTranscriptionAudioUrl(null); // This is often shared or specifically set
    }
    if (except !== 'file') {
        setMainVideoFile(null);
        // setTranscriptionAudioFile(null); // This is often shared or specifically set
    }

    // Smartly clear mainVideoSrc unless it belongs to the 'except' method
    if (except === 'preset' && (mainVideoFile || loadedMainVideoUrl)) setMainVideoSrc(null);
    else if (except === 'url' && (mainVideoFile || (loadedPresetId && !mainVideoUrlInput))) setMainVideoSrc(null);
    else if (except === 'file' && (loadedMainVideoUrl || (loadedPresetId && !mainVideoFile))) setMainVideoSrc(null);
    else if (!except) { // Clear all if no exception
        if (mainVideoSrc && mainVideoSrc.startsWith('blob:')) URL.revokeObjectURL(mainVideoSrc);
        setMainVideoSrc(null);
    }
    
    // Always clear specific audio sources if changing main input type.
    // This could be refined based on desired UX (e.g., keep optional audio if user just switches main video type).
    if (except !== 'url') setLoadedTranscriptionAudioUrl(null);
    if (except !== 'file') setTranscriptionAudioFile(null);
  };


  const handleShowAlternativeMethod = (method: 'url' | 'file') => {
    if (activeAlternativeMethod === method) { // Toggle off if clicking the same button
        setActiveAlternativeMethod(null);
        // Optionally, clear the inputs of the method being hidden
        // if (method === 'url') { setMainVideoUrlInput(""); setTranscriptionAudioUrlInput(""); }
        // if (method === 'file') { setMainVideoFile(null); setTranscriptionAudioFile(null); }
        // For now, let's keep them so user can toggle back. 
        // Main video src clearing handled by resetAllInputMethods if needed.
    } else {
        setActiveAlternativeMethod(method);
        resetAllInputMethods(method); // Clear other methods
        if (mainVideoSrc) { // If there was a video source from another method, clear it.
            if (mainVideoSrc.startsWith('blob:')) URL.revokeObjectURL(mainVideoSrc);
            setMainVideoSrc(null);
        }
    }
    resetUIAndAIStatesForNewSource(); // Reset processing state
    // buildInitialStatus will be called by useEffect
  };


  const resetAIStates = useCallback((forNewVideo: boolean = true) => { 
    setScriptSegments([]);
    setContextualImages({});
    setActiveContextualImageSrc(null);
    if (forNewVideo) { 
        // Clearing these here might conflict with user's intent if they are just reprocessing
        // The specific input handlers (handleMainVideoUpload, handleLoadPreset, etc.)
        // are now more responsible for clearing other input sources.
        // setTranscriptionAudioFile(null); 
        // setLoadedTranscriptionAudioUrl(null);
        // setTranscriptionAudioUrlInput("");
        // setLoadedPresetId(null); 
        // setPresetInput(""); 
        // setCurrentPresetStatus("");
    }
    
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
  }, [geminiApiKeyExists, PIXABAY_API_KEY, ASSEMBLYAI_API_KEY, activeAlternativeMethod]); 
  
  useEffect(() => {
    resetAIStates(true); // Reset on mount or when key dependencies for AI change.
  }, [resetAIStates]); 

  const handlePresetInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setPresetInput(event.target.value);
    setCurrentPresetStatus(""); 
  };

  const handleLoadPreset = () => {
    const presetIdStr = presetInput.trim();
    if (!presetIdStr || !/^\d+$/.test(presetIdStr)) {
      setCurrentPresetStatus("Invalid preset. Please enter a number.");
      return;
    }
    const id = parseInt(presetIdStr, 10);

    setIsPresetLoading(true);
    setCurrentPresetStatus(`Loading preset ${id}...`);
    
    setTimeout(() => { // Simulate network delay
      const videoUrl = `https://darkslategray-octopus-566678.hostingersite.com/${id}.mp4`;
      const audioUrl = `https://darkslategray-octopus-566678.hostingersite.com/${id}.mp3`;
      
      if (mainVideoSrc && mainVideoSrc.startsWith('blob:')) URL.revokeObjectURL(mainVideoSrc);
      
      setMainVideoSrc(videoUrl);
      setLoadedMainVideoUrl(videoUrl); // Presets use URL loading internally for video
      setLoadedTranscriptionAudioUrl(audioUrl); 
      setLoadedPresetId(id);

      // Clear other input methods
      setMainVideoFile(null); 
      setTranscriptionAudioFile(null);
      setMainVideoUrlInput(""); // Clear direct URL input if preset is used
      setTranscriptionAudioUrlInput("");
      setActiveAlternativeMethod(null); // Hide alternative methods

      resetUIAndAIStatesForNewSource();
      const statusMsg = `Preset ${id} loaded. Video: .../${id}.mp4, Audio: .../${id}.mp3. Ready to process.`;
      setTranscriptionStatus(statusMsg);
      setCurrentPresetStatus(`Preset ${id} loaded.`);
      setIsPresetLoading(false);
    }, 500); 
  };


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
    if (!query || !PIXABAY_API_KEY || PIXABAY_API_KEY === "YOUR_PIXABAY_API_KEY") return null;
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
    if (!PIXABAY_API_KEY || PIXABAY_API_KEY === "YOUR_PIXABAY_API_KEY") {
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
    if (!mainVideoSrc) { 
      setTranscriptionStatus("Error: Main video source is missing. Please use a preset, load URL, or upload a file.");
      return;
    }
    if (!ASSEMBLYAI_API_KEY) {
      setTranscriptionStatus("Error: AssemblyAI API Key missing.");
      return;
    }
    if (!geminiApiKeyExists || !aiRef.current) {
        setTranscriptionStatus("Error: Gemini API Key missing. Cannot proceed with visual suggestions.");
        return;
    }
    if (!PIXABAY_API_KEY || PIXABAY_API_KEY === "YOUR_PIXABAY_API_KEY") {
        setTranscriptionStatus("Error: Pixabay API Key missing or invalid. Cannot fetch images.");
        return;
    }

    setIsProcessingAI(true);
    setScriptSegments([]);
    setContextualImages({});
    setActiveContextualImageSrc(null);
    setAssemblyAiStatus('idle');
    setAssemblyAiTranscriptId(null);
    if (pollingTimeoutRef.current) clearTimeout(pollingTimeoutRef.current);
    setActiveSegmentIndex(-1);


    let audioSourceForAssembly: { url: string } | { file: File } | null = null;
    let audioSourceName = "";

    // Determine audio source priority: dedicated audio URL, then dedicated audio file, then main video source (URL or file)
    if (loadedTranscriptionAudioUrl) {
        audioSourceForAssembly = { url: loadedTranscriptionAudioUrl };
        audioSourceName = (loadedPresetId !== null && loadedTranscriptionAudioUrl.includes(`/${loadedPresetId}.mp3`)) 
                            ? `preset ${loadedPresetId} audio URL` 
                            : "custom audio URL";
    } else if (transcriptionAudioFile) {
        audioSourceForAssembly = { file: transcriptionAudioFile };
        audioSourceName = "custom audio file";
    } else if (loadedMainVideoUrl) { // This implies mainVideoSrc is also loadedMainVideoUrl
        audioSourceForAssembly = { url: loadedMainVideoUrl };
        audioSourceName = loadedPresetId !== null ? `audio from preset ${loadedPresetId} video URL` : `audio from video URL`;
    } else if (mainVideoFile) { // This implies mainVideoSrc is from mainVideoFile
        audioSourceForAssembly = { file: mainVideoFile };
        audioSourceName = 'audio from video file';
    }
    // Note: mainVideoSrc could be a URL not captured by loadedMainVideoUrl if preset was just loaded and loadedMainVideoUrl was cleared.
    // The logic in handleLoadPreset ensures loadedMainVideoUrl and loadedTranscriptionAudioUrl are set correctly for presets.

    if (!audioSourceForAssembly) {
        setTranscriptionStatus("Error: No audio source for transcription could be determined. Please ensure a main video/audio is loaded.");
        setIsProcessingAI(false);
        return;
    }
    
    setTranscriptionStatus(`AssemblyAI: Preparing ${audioSourceName}...`);
    setAssemblyAiStatus('uploading'); 

    try {
      let audio_url_for_transcription: string | null = null;

      if ('url' in audioSourceForAssembly) {
        audio_url_for_transcription = audioSourceForAssembly.url;
        setTranscriptionStatus(`AssemblyAI: Submitting ${audioSourceName} for transcription...`);
      } else if ('file' in audioSourceForAssembly) {
        setTranscriptionStatus(`AssemblyAI: Uploading ${audioSourceName}...`);
        const formData = new FormData();
        formData.append('file', audioSourceForAssembly.file);
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
        if (!audio_url_for_transcription) {
          throw new Error("AssemblyAI Upload Error: No upload_url received.");
        }
        setTranscriptionStatus(`AssemblyAI: ${audioSourceName} uploaded. Submitting for transcription...`);
      }

      if (!audio_url_for_transcription) {
        throw new Error("Critical error: audio URL for transcription not established.");
      }

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
    if (!mainVideoRef.current || !allContextualDataProcessed) return;
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
    if (mainVideoRef.current && allContextualDataProcessed) {
        mainVideoRef.current.currentTime = time;
        setCurrentTime(time); 
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
      const onEnded = () => { setIsPlaying(false); setActiveSegmentIndex(-1); }; 
      const onLoadedMeta = () => {
        if (videoNode.duration !== Infinity && !isNaN(videoNode.duration)) { // Check for valid duration
            setVideoDuration(videoNode.duration);
        }
        setCurrentTime(videoNode.currentTime); 
      };
      
      // Reset currentTime if src changes and it's not a blob (i.e. not a file just re-selected)
      // This helps if user switches between URLs or presets.
      if(mainVideoSrc && !mainVideoSrc.startsWith('blob:') && videoNode.src !== mainVideoSrc){
        videoNode.currentTime = 0;
        setCurrentTime(0);
        setVideoDuration(0); // Reset duration as well until new metadata loads
      }

      videoNode.addEventListener('play', onPlay);
      videoNode.addEventListener('pause', onPause);
      videoNode.addEventListener('ended', onEnded);
      videoNode.addEventListener('timeupdate', handleTimeUpdate);
      videoNode.addEventListener('loadedmetadata', onLoadedMeta);
      
      if (videoNode.readyState >= 1) { // HAVE_METADATA or greater
        onLoadedMeta();
      }

      return () => {
        videoNode.removeEventListener('play', onPlay);
        videoNode.removeEventListener('pause', onPause);
        videoNode.removeEventListener('ended', onEnded);
        videoNode.removeEventListener('timeupdate', handleTimeUpdate);
        videoNode.removeEventListener('loadedmetadata', onLoadedMeta);
      };
    }
  }, [mainVideoSrc, handleTimeUpdate]); 


  const formatTime = (seconds: number): string => {
    if (isNaN(seconds) || seconds < 0) return "0:00";
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const isPresetInputValid = presetInput.trim() !== "" && /^\d+$/.test(presetInput.trim());
  const mainVideoUrlValidForLoad = mainVideoUrlInput.trim().startsWith("http");
  const audioUrlValidForLoad = transcriptionAudioUrlInput.trim().startsWith("http");


  return (
    <div className="min-h-screen bg-gray-800 text-gray-100 flex flex-col items-center p-4 selection:bg-purple-500 selection:text-white">
      <header className="w-full max-w-5xl mb-6 text-center">
        <h1 className="text-4xl font-bold text-purple-400">AI Video Visualizer</h1>
        <p className="text-gray-400 mt-1">Provide video/audio via preset, URL, or file. Get transcriptions & AI-suggested visuals synced to dialogue.</p>
      </header>

      {!geminiApiKeyExists && ( <div className="w-full max-w-3xl p-3 mb-3 bg-red-800 text-red-100 border border-red-600 rounded-md text-sm text-center"><strong>Critical Error:</strong> Gemini API Key (process.env.API_KEY) is not set. Visual suggestions will not function.</div>)}
      {(!PIXABAY_API_KEY || PIXABAY_API_KEY === "YOUR_PIXABAY_API_KEY") && (<div className="w-full max-w-3xl p-3 mb-3 bg-red-800 text-red-100 border border-red-600 rounded-md text-sm text-center"><strong>Critical Error:</strong> Pixabay API Key is not set or is invalid. Image fetching will not function. Update <code>App.tsx</code>.</div>)}
      {!ASSEMBLYAI_API_KEY && (<div className="w-full max-w-3xl p-3 mb-3 bg-red-800 text-red-100 border border-red-600 rounded-md text-sm text-center"><strong>Critical Error:</strong> AssemblyAI API Key is not set. Transcription will not function. Update <code>App.tsx</code>.</div> )}

      <main className="w-full max-w-5xl flex flex-col md:flex-row gap-6">
        <div className="md:w-1/3 space-y-4 bg-gray-700 p-4 rounded-lg shadow-xl">
          <h2 className="text-xl font-semibold text-purple-300 border-b border-purple-400 pb-2">Configuration</h2>
          
          {/* Preset Section (Always Visible) */}
          <div className="space-y-2 p-3 bg-gray-600 rounded-md shadow">
            <label htmlFor="presetInput" className="block text-sm font-medium text-gray-300">
              A. Use Preset (Enter Number)
            </label>
            <div className="flex items-center space-x-2">
              <input type="number" id="presetInput" value={presetInput} onChange={handlePresetInputChange} placeholder="e.g., 1, 7" min="1" className="w-28 p-1.5 text-sm bg-gray-800 text-gray-200 border border-gray-500 rounded focus:ring-1 focus:ring-purple-500 focus:border-purple-500" aria-describedby="preset-status"/>
              <button onClick={handleLoadPreset} disabled={!isPresetInputValid || isPresetLoading} className={`px-3 py-1.5 text-sm font-semibold rounded-md transition-all duration-150 ease-in-out ${(!isPresetInputValid || isPresetLoading) ? 'bg-gray-500 text-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}>
                {isPresetLoading ? 'Loading...' : 'Load Preset'}
              </button>
            </div>
            {currentPresetStatus && (<p id="preset-status" className={`text-xs mt-1 ${currentPresetStatus.includes("Invalid") || currentPresetStatus.includes("Error") ? 'text-red-400' : 'text-green-400'}`}>{currentPresetStatus}</p>)}
          </div>
          
          {/* Alternative Method Selection */}
          <div className="p-3 bg-gray-600 rounded-md shadow">
            <h3 className="text-sm font-medium text-gray-300 mb-2">B. Or, Select Another Input Method:</h3>
            <div className="flex space-x-2">
                <button 
                    onClick={() => handleShowAlternativeMethod('url')} 
                    className={`flex-1 px-3 py-1.5 text-sm font-semibold rounded-md transition-all ${activeAlternativeMethod === 'url' ? 'bg-purple-600 hover:bg-purple-700 text-white ring-2 ring-purple-300' : 'bg-gray-500 hover:bg-gray-400 text-white'}`}
                >
                    Show URL Inputs
                </button>
                <button 
                    onClick={() => handleShowAlternativeMethod('file')}
                    className={`flex-1 px-3 py-1.5 text-sm font-semibold rounded-md transition-all ${activeAlternativeMethod === 'file' ? 'bg-purple-600 hover:bg-purple-700 text-white ring-2 ring-purple-300' : 'bg-gray-500 hover:bg-gray-400 text-white'}`}
                >
                    Show File Uploads
                </button>
            </div>
          </div>

          {/* Conditional URL Input Section */}
          {activeAlternativeMethod === 'url' && (
            <div className="space-y-3 p-3 bg-gray-600/70 rounded-md shadow animate-fadeIn"> {/* Added animate-fadeIn for smoother appearance */}
              <h3 className="text-sm font-medium text-gray-300">Load from URL</h3>
              <div>
                  <label htmlFor="mainVideoUrlInput" className="block text-xs font-medium text-gray-300 mb-0.5">Main Video URL:</label>
                  <div className="flex items-center space-x-2">
                      <input type="url" id="mainVideoUrlInput" value={mainVideoUrlInput} onChange={(e) => setMainVideoUrlInput(e.target.value)} placeholder="https://example.com/video.mp4" className="flex-grow p-1.5 text-sm bg-gray-800 text-gray-200 border border-gray-500 rounded focus:ring-1 focus:ring-purple-500 focus:border-purple-500"/>
                      <button onClick={handleLoadMainVideoUrl} disabled={!mainVideoUrlValidForLoad} className={`px-3 py-1.5 text-sm font-semibold rounded-md transition-all ${!mainVideoUrlValidForLoad ? 'bg-gray-500 text-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}>Load</button>
                  </div>
              </div>
              <div>
                  <label htmlFor="transcriptionAudioUrlInput" className="block text-xs font-medium text-gray-300 mb-0.5">Audio URL for Transcription (Optional):</label>
                  <div className="flex items-center space-x-2">
                      <input type="url" id="transcriptionAudioUrlInput" value={transcriptionAudioUrlInput} onChange={(e) => setTranscriptionAudioUrlInput(e.target.value)} placeholder="https://example.com/audio.mp3" className="flex-grow p-1.5 text-sm bg-gray-800 text-gray-200 border border-gray-500 rounded focus:ring-1 focus:ring-purple-500 focus:border-purple-500"/>
                      <button onClick={handleLoadTranscriptionAudioUrl} disabled={!audioUrlValidForLoad} className={`px-3 py-1.5 text-sm font-semibold rounded-md transition-all ${!audioUrlValidForLoad ? 'bg-gray-500 text-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}>Load</button>
                  </div>
              </div>
            </div>
          )}

          {/* Conditional File Upload Section */}
          {activeAlternativeMethod === 'file' && (
             <div className="p-3 bg-gray-600/70 rounded-md shadow animate-fadeIn"> {/* Added animate-fadeIn */}
               <h3 className="text-sm font-medium text-gray-300 mb-2">Upload Files</h3>
              <FileUpload
                  label="Main Video File"
                  onFileUpload={handleMainVideoUpload}
                  accept="video/*"
                  currentFile={mainVideoFile}
                  isRequired={!mainVideoSrc && activeAlternativeMethod === 'file'} 
              />
              <FileUpload
                  label="Audio File for Transcription (Optional)"
                  onFileUpload={handleTranscriptionAudioUpload}
                  accept="audio/*"
                  currentFile={transcriptionAudioFile}
                  isRequired={false}
              />
            </div>
          )}
          
          <button
            onClick={handleTranscribeAndProcessSentences}
            disabled={!canStartProcessing || isProcessingAI}
            className={`w-full mt-4 px-4 py-2.5 text-base font-semibold rounded-md transition-all duration-150 ease-in-out
                        ${canStartProcessing && !isProcessingAI ? 'bg-green-600 hover:bg-green-700 text-white shadow-lg' : 'bg-gray-500 text-gray-400 cursor-not-allowed'}`}
            aria-live="polite"
          >
            {isProcessingAI ? 'Processing AI...' : 'Process Video & Visuals'}
          </button>
          <div className="text-xs text-gray-400 p-2 bg-gray-800 rounded min-h-[50px] overflow-y-auto max-h-[150px] mt-2">
            Status: <span className="font-medium text-gray-300">{transcriptionStatus}</span>
          </div>
        </div>

        <div className="md:w-2/3 flex flex-col items-center">
          <VideoStage 
            ref={mainVideoRef} 
            mainVideoSrc={mainVideoSrc}
            contextualImageSrc={activeContextualImageSrc}
            isPlaying={isPlaying} 
          />
          {mainVideoSrc && (
            <div className="mt-4 w-full max-w-sm md:max-w-md">
                <button 
                    onClick={handlePlayPause}
                    disabled={!canStartPlayback}
                    className={`w-full px-4 py-2 font-semibold rounded-md transition-colors duration-150
                                ${canStartPlayback ? 'bg-purple-600 hover:bg-purple-700 text-white' : 'bg-gray-500 text-gray-400 cursor-not-allowed'}`}
                >
                    {isPlaying ? 'Pause' : 'Play'}
                </button>
                {videoDuration > 0 && (
                  <div className="mt-2 text-center text-sm text-gray-400">
                    {formatTime(currentTime)} / {formatTime(videoDuration)}
                  </div>
                )}
            </div>
          )}
           {!mainVideoSrc && (
            <div className="w-full max-w-sm md:max-w-md aspect-[9/16] bg-gray-700 rounded-xl shadow-2xl flex items-center justify-center border-4 border-gray-600">
                <p className="text-gray-400 text-lg">Video Player Area</p>
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
                               ${activeSegmentIndex === index && isPlaying ? 'bg-purple-700 border-purple-300 shadow-lg scale-[1.01]' : 'bg-gray-600 border-gray-500 hover:bg-gray-550'}
                               ${allContextualDataProcessed ? 'cursor-pointer' : 'cursor-default'}`}
                   onClick={() => allContextualDataProcessed && handleSeek(segment.startTime)}
                   role="button"
                   tabIndex={allContextualDataProcessed ? 0 : -1}
                   onKeyDown={(e) => allContextualDataProcessed && e.key === 'Enter' && handleSeek(segment.startTime)}
                   aria-label={`Play segment: ${segment.text.substring(0,50)}...`}
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
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-5px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fadeIn {
          animation: fadeIn 0.3s ease-out forwards;
        }
      `}</style>
    </div>
  );
};

export default App;
