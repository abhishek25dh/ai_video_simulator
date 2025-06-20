
import React, { useEffect, useState, forwardRef, useRef } from 'react';
import { ContextualImageDisplay } from './ContextualImageDisplay';

interface VideoStageProps {
  mainVideoSrc: string | null;
  contextualImageSrc: string | null; 
  isPlaying: boolean;
  isVideoBuffering?: boolean; // New prop
}

export const VideoStage = forwardRef<HTMLVideoElement, VideoStageProps>(({ 
  mainVideoSrc, 
  contextualImageSrc, 
  isPlaying,
  isVideoBuffering = false,
}, ref) => {
  const localVideoRef = useRef<HTMLVideoElement>(null); 
  const [isZoomed, setIsZoomed] = useState(false);
  const zoomTimeoutRef = useRef<number | null>(null);

  const videoElementRef = (ref || localVideoRef) as React.RefObject<HTMLVideoElement>;

  useEffect(() => {
    const clearZoomTimeout = () => {
      if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
      zoomTimeoutRef.current = null;
    };

    const manageZoomCycle = () => {
      clearZoomTimeout();
      if (!isPlaying) {
        setIsZoomed(false); return;
      }
      const delay = isZoomed ? (Math.random() * 1000 + 2000) : (Math.random() * 2000 + 4000);
      zoomTimeoutRef.current = window.setTimeout(() => setIsZoomed(prev => !prev), delay);
    };

    if (isPlaying) manageZoomCycle();
    else { clearZoomTimeout(); setIsZoomed(false); }
    return clearZoomTimeout;
  }, [isPlaying, isZoomed]);

  return (
    <div 
      className={`
        w-full max-w-sm md:max-w-md aspect-[9/16] bg-black 
        rounded-xl shadow-2xl overflow-hidden relative 
        border-4 border-purple-500 
        transition-transform duration-500 ease-in-out
        ${isZoomed ? 'scale-105' : 'scale-100'} 
      `}
      style={{ transformOrigin: 'center center' }}
    >
      {mainVideoSrc && (
        <video
          ref={videoElementRef} 
          src={mainVideoSrc}
          // loop // Removed: Video will not loop automatically
          playsInline 
          className="absolute top-0 left-0 w-full h-full object-cover z-0"
        />
      )}
      {!mainVideoSrc && (
        <div className="w-full h-full flex items-center justify-center bg-gray-700 z-0">
            <p className="text-gray-400">Configure Main Video Input</p>
        </div>
      )}
      
      <div className="absolute inset-0 w-full h-full z-20 pointer-events-none">
        <ContextualImageDisplay src={contextualImageSrc} /> 
      </div>

      {isVideoBuffering && mainVideoSrc && (
         <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-75 z-40">
            <div className="flex flex-col items-center">
                <svg className="animate-spin h-10 w-10 text-white mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <p className="text-white text-sm">Loading video...</p>
            </div>
         </div>
      )}

      {!isPlaying && mainVideoSrc && !isVideoBuffering && ( // Show play icon if video is loaded/ready but not playing
         <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 z-30">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-24 w-24 text-white opacity-70 cursor-pointer" viewBox="0 0 20 20" fill="currentColor"
                 onClick={() => { if(videoElementRef.current) videoElementRef.current.play().catch(e => console.error(e))}} // Allow clicking overlay to play if conditions in App allow
            >
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
            </svg>
         </div>
      )}
    </div>
  );
});
