
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

const PIXABAY_API_KEY = "YOUR_PIXABAY_API_KEY"; // <<< IMPORTANT: Replace with your actual Pixabay API Key
const PIXABAY_URL = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&image_type=photo&orientation=horizontal&safesearch=true&per_page=3`;

interface PresetVideo {
  id: number;
  name: string;
  src: string; // Placeholder, could be a real URL in a full app
  mockFileSize: number;
  mockFileType: string;
  description: string;
}

const PRESET_VIDEOS: PresetVideo[] = [
  { id: 1, name: "Preset: Tech Review", src: "placeholder_tech_review.mp4", mockFileSize: 5 * 1024 * 1024, mockFileType: 'video/mp4', description: "A short clip discussing new gadgets." },
  { id: 2, name: "Preset: Nature Walk", src: "placeholder_nature_walk.mp4", mockFileSize: 8 * 1024 * 1024, mockFileType: 'video/mp4', description: "Scenic views and commentary on wildlife." },
  { id: 3, name: "Preset: Cooking Tutorial", src: "placeholder_cooking_tutorial.mp4", mockFileSize: 6 * 1024 * 1024, mockFileType: 'video/mp4', description: "A quick recipe demonstration." },
  { id: 4, name: "Preset: Story Time", src: "placeholder_story_time.mp4", mockFileSize: 4 * 1024 * 1024, mockFileType: 'video/mp4', description: "An engaging narrative for all ages." },
];


const App: React.FC = () => {
  const [mainVideoFile, setMainVideoFile] = useState<File | null>(null);
  const [mainVideoSrc, setMainVideoSrc] = useState<string | null>(null);
  const [transcriptionAudioFile, setTranscriptionAudioFile] = useState<File | null>(null);

  const mainVideoRef = useRef<HTMLVideoElement>(null);
  const pollingTimeoutRef = useRef<number | null>(null);

  const [scriptSegments, setScriptSegments] = useState<ScriptSegment[]>([]);
  const [isProcessingAI, setIsProcessingAI] = useState(false);
  const [transcriptionStatus, setTranscriptionStatus] = useState("Idle. Upload video or select a preset to start.");

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

  // Preset related state
  const [presetInput, setPresetInput] = useState<string>("");
  const [selectedPreset, setSelectedPreset] = useState<PresetVideo | null>(null);
  const [isPresetLoading, setIsPresetLoading] = useState<boolean>(false);
  const [currentPresetStatus, setCurrentPresetStatus] = useState<string>("");


  useEffect(() => {
    if (process.env.API_KEY) {
      aiRef.current = new GoogleGenAI({ apiKey: process.env.API_KEY });
      setGeminiApiKeyExists(true);
    } else {
      setGeminiApiKeyExists(false);
      // This status update will be handled by buildInitialStatus
      console.error("Gemini API_KEY environment variable not set.");
    }
  }, []);

  useEffect(() => {
    // This effect ensures transcriptionStatus is up-to-date when API key status changes
    // or when the component initially mounts.
    setTranscriptionStatus(buildInitialStatus());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geminiApiKeyExists, mainVideoFile, PIXABAY_API_KEY, ASSEMBLYAI_API_KEY]);


  const allContextualDataProcessed = assemblyAiStatus === 'completed' && !isProcessingAI && scriptSegments.length > 0;

  const canStartProcessing = !!mainVideoFile && !isProcessingAI && !!ASSEMBLYAI_API_KEY && geminiApiKeyExists && !!PIXABAY_API_KEY && PIXABAY_API_KEY !== "YOUR_PIXABAY_API_KEY";
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
    
    if (mainVideoFile) return "Ready to process video.";
    if (selectedPreset) return `Preset '${selectedPreset.name}' loaded. Ready to process.`;
    return "Idle. Upload video or select a preset to start.";
  }

  const handleMainVideoUpload = (file: File) => {
    setMainVideoFile(file);
    if (mainVideoSrc) URL.revokeObjectURL(mainVideoSrc);
    setMainVideoSrc(URL.createObjectURL(file));
    
    // Clear preset selection if manual upload occurs
    setPresetInput("");
    setSelectedPreset(null);
    setCurrentPresetStatus("");

    let baseStatus = buildInitialStatus(); // buildInitialStatus will now correctly reflect no preset
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
    // Reset playback related states when new video is uploaded
    setIsPlaying(false);
    setCurrentTime(0);
    setVideoDuration(0);
    setActiveSegmentIndex(-1);
    // Also reset AI processing states
    setScriptSegments([]);
    setContextualImages({});
    setActiveContextualImageSrc(null);
    setAssemblyAiStatus('idle');
    setAssemblyAiTranscriptId(null);
    setIsProcessingAI(false);
    if (pollingTimeoutRef.current) clearTimeout(pollingTimeoutRef.current);

  };
  
  const handleTranscriptionAudioUpload = (file: File) => {
    setTranscriptionAudioFile(file);
    setTranscriptionStatus(prevStatus => {
      const audioMsg = "Optional audio for transcription uploaded.";
      if (prevStatus.includes(audioMsg)) return prevStatus; 
      if (prevStatus.startsWith("Idle.") || (!mainVideoFile && !selectedPreset)) return audioMsg + " Upload main video or load preset to proceed.";
      return prevStatus.endsWith(".") ? prevStatus + " " + audioMsg : prevStatus + ". " + audioMsg;
    });
  };

  const resetAIStates = useCallback((forNewVideo: boolean = true) => {
    setScriptSegments([]);
    setContextualImages({});
    setActiveContextualImageSrc(null);
    if (forNewVideo) { // Only reset these if it's a completely new video/preset scenario
        setTranscriptionAudioFile(null); 
        // Do not reset mainVideoFile or mainVideoSrc here as they are set by upload/preset
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
    // setVideoDuration will be set by onLoadedMetadata
    if (forNewVideo) {
        setPresetInput("");
        setSelectedPreset(null);
        setCurrentPresetStatus("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geminiApiKeyExists]); 
  
  useEffect(() => {
    // Initial full reset when app loads, considering API key status
    resetAIStates(true);
  }, [resetAIStates]); 

  const handlePresetInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setPresetInput(event.target.value);
    setCurrentPresetStatus(""); // Clear status on new input
  };

  const handleLoadPreset = () => {
    const id = parseInt(presetInput, 10);
    const preset = PRESET_VIDEOS.find(p => p.id === id);

    if (preset) {
      setIsPresetLoading(true);
      setCurrentPresetStatus(`Loading preset '${preset.name}'...`);
      
      // Simulate loading delay
      setTimeout(() => {
        const mockFile = new File(
          [`dummy video content for ${preset.name}`], 
          preset.name, 
          { type: preset.mockFileType, lastModified: Date.now() }
        );
        setMainVideoFile(mockFile);
        
        // For local placeholders, URL.createObjectURL might not be ideal
        // as the content isn't a real video.
        // Using the placeholder src directly. The video element might show an error
        // or nothing, but the app logic will proceed as if a video is loaded.
        if (mainVideoSrc) URL.revokeObjectURL(mainVideoSrc); // Revoke old src if it was an object URL
        setMainVideoSrc(preset.src); // Use placeholder string src

        setSelectedPreset(preset);
        setTranscriptionAudioFile(null); // Clear any custom audio

        // Reset states for new video
        setScriptSegments([]);
        setContextualImages({});
        setActiveContextualImageSrc(null);
        setAssemblyAiStatus('idle');
        setAssemblyAiTranscriptId(null);
        setIsProcessingAI(false);
        setIsPlaying(false);
        setCurrentTime(0);
        setVideoDuration(0); // Will be updated by onLoadedMetadata if video src is valid
        setActiveSegmentIndex(-1);
        
        setTranscriptionStatus(`Preset '${preset.name}' loaded. Ready to process video.`);
        setCurrentPresetStatus(`Preset '${preset.name}' is loaded.`);
        setIsPresetLoading(false);
      }, 1000); // 1 second simulated load time
    } else {
      setCurrentPresetStatus("Invalid preset number. Please choose from available presets.");
    }
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
        return data.hits[0].webformatURL; // Or largeImageURL for higher quality
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
          updatedSegments[i].pixabayFetchStatus = 'failed_fetch'; // Or 'no_image_found' if API was ok but no results
          newContextualImages[i] = null;
        }
      } else {
        updatedSegments[i].pixabayFetchStatus = 'no_image_found'; // No suggestion means no image
        newContextualImages[i] = null;
      }
      setScriptSegments([...updatedSegments]); 
      setContextualImages(prev => ({...prev, ...newContextualImages})); 
    }
    setContextualImages(newContextualImages); // Ensure final state is set
    setTranscriptionStatus("Visual processing complete.");
    setIsProcessingAI(false);
  };
  
  const handleTranscribeAndProcessSentences = async () => {
    if (!mainVideoFile) { 
      setTranscriptionStatus("Error: Main video is missing. Please upload or select a preset.");
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


    const fileToTranscribe = transcriptionAudioFile || mainVideoFile; 

    setIsProcessingAI(true);
    // const currentStatus = buildInitialStatus(); // Status before processing starts
    setScriptSegments([]); // Clear previous segments immediately
    setContextualImages({});
    setActiveContextualImageSrc(null);
    setActiveSegmentIndex(-1);
    setEditingUrlForSegmentKey(null);
    setCurrentUserInputUrl("");
    setAssemblyAiStatus('idle'); // Reset AssemblyAI status for new processing
    setAssemblyAiTranscriptId(null);
    if (pollingTimeoutRef.current) clearTimeout(pollingTimeoutRef.current);
    
    // Set status to indicate start of AssemblyAI processing
    const audioSourceName = transcriptionAudioFile ? 'custom audio' : (selectedPreset ? `preset video '${selectedPreset.name}' audio` : 'video audio');
    setTranscriptionStatus(`AssemblyAI: Uploading ${audioSourceName}...`);
    setAssemblyAiStatus('uploading');


    const formData = new FormData();
    formData.append('file', fileToTranscribe);

    try {
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
      const audio_url_for_transcription = uploadData.upload_url; 

      if (!audio_url_for_transcription) {
        throw new Error("AssemblyAI Upload Error: No upload_url received.");
      }

      setTranscriptionStatus(`AssemblyAI: ${audioSourceName} uploaded. Submitting for transcription...`);
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

      videoNode.addEventListener('play', onPlay);
      videoNode.addEventListener('pause', onPause);
      videoNode.addEventListener('ended', onEnded);
      videoNode.addEventListener('timeupdate', handleTimeUpdate);
      videoNode.addEventListener('loadedmetadata', onLoadedMeta);
      
      if (videoNode.readyState >= 1) { 
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

  const currentPresetValid = PRESET_VIDEOS.some(p => p.id === parseInt(presetInput, 10));


  return (
    <div className="min-h-screen bg-gray-800 text-gray-100 flex flex-col items-center p-4 selection:bg-purple-500 selection:text-white">
      <header className="w-full max-w-5xl mb-6 text-center">
        <h1 className="text-4xl font-bold text-purple-400">AI Video Visualizer</h1>
        <p className="text-gray-400 mt-1">Upload a video or select a preset, get it transcribed, and see AI-suggested contextual images synced to the dialogue.</p>
      </header>

      {!geminiApiKeyExists && (
          <div className="w-full max-w-3xl p-4 mb-4 bg-red-800 text-red-100 border border-red-600 rounded-md text-center">
              <strong>Critical Error:</strong> Gemini API Key (process.env.API_KEY) is not set. Visual suggestions will not function. Please set this environment variable.
          </div>
      )}
      {(!PIXABAY_API_KEY || PIXABAY_API_KEY === "YOUR_PIXABAY_API_KEY") && (
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
          <h2 className="text-xl font-semibold text-purple-300 border-b border-purple-400 pb-2">Configuration</h2>
          
          {/* Preset Selection Area */}
          <div className="space-y-2 p-3 bg-gray-600 rounded-md">
            <label htmlFor="presetInput" className="block text-sm font-medium text-gray-300">
              Use Preset Video (e.g., 1-{PRESET_VIDEOS.length})
            </label>
            <div className="flex items-center space-x-2">
              <input
                type="number"
                id="presetInput"
                value={presetInput}
                onChange={handlePresetInputChange}
                placeholder={`1-${PRESET_VIDEOS.length}`}
                min="1"
                max={PRESET_VIDEOS.length.toString()}
                className="w-20 p-1.5 text-sm bg-gray-800 text-gray-200 border border-gray-500 rounded focus:ring-1 focus:ring-purple-500 focus:border-purple-500"
                aria-describedby="preset-status"
              />
              <button
                onClick={handleLoadPreset}
                disabled={!currentPresetValid || isPresetLoading}
                className={`px-3 py-1.5 text-sm font-semibold rounded-md transition-all duration-150 ease-in-out
                            ${(!currentPresetValid || isPresetLoading) ? 'bg-gray-500 text-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}
              >
                {isPresetLoading ? 'Loading...' : 'Load Preset'}
              </button>
            </div>
            {currentPresetStatus && (
              <p id="preset-status" className={`text-xs mt-1 ${currentPresetStatus.includes("Invalid") || currentPresetStatus.includes("Error") ? 'text-red-400' : 'text-green-400'}`}>
                {currentPresetStatus}
              </p>
            )}
             <details className="text-xs text-gray-400 mt-1 cursor-pointer">
                <summary className="hover:text-gray-300">Available Presets</summary>
                <ul className="list-disc list-inside pl-2 mt-1 bg-gray-700 p-2 rounded">
                    {PRESET_VIDEOS.map(p => <li key={p.id}><strong>{p.id}:</strong> {p.name} - <em>{p.description}</em></li>)}
                </ul>
            </details>
          </div>
          
          <p className="text-center text-gray-400 text-sm">OR</p>

          <FileUpload
            label="1. Upload Main Video"
            onFileUpload={handleMainVideoUpload}
            accept="video/*"
            currentFile={mainVideoFile}
            isRequired={!selectedPreset} // Required if no preset is selected
          />
          <FileUpload
            label="2. Upload Audio for Transcription (Optional)"
            onFileUpload={handleTranscriptionAudioUpload}
            accept="audio/*"
            currentFile={transcriptionAudioFile}
            isRequired={false}
          />
          
          <button
            onClick={handleTranscribeAndProcessSentences}
            disabled={!canStartProcessing || isProcessingAI}
            className={`w-full px-4 py-2 text-base font-semibold rounded-md transition-all duration-150 ease-in-out
                        ${canStartProcessing && !isProcessingAI ? 'bg-green-600 hover:bg-green-700 text-white' : 'bg-gray-500 text-gray-400 cursor-not-allowed'}`}
            aria-live="polite"
          >
            {isProcessingAI ? 'Processing AI...' : '3. Process Video & Visuals'}
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
          />
          {(mainVideoSrc || selectedPreset) && (
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
                               ${allContextualDataProcessed ? 'cursor-pointer' : 'cursor-default'}`}
                   onClick={() => allContextualDataProcessed && handleSeek(segment.startTime)}
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
