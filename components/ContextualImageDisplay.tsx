
import React, { useState, useEffect, useRef } from 'react';

interface ContextualImageDisplayProps {
  src: string | null;
}

const ANIMATION_TYPES = ['pan-lr', 'pan-rl', 'zoom-in'] as const;
type AnimationType = typeof ANIMATION_TYPES[number] | null;

interface ImageDetails {
  key: string; 
  url: string;
  animation: AnimationType;
}

export const ContextualImageDisplay: React.FC<ContextualImageDisplayProps> = ({ src }) => {
  const [currentImageDetails, setCurrentImageDetails] = useState<ImageDetails | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const srcAssociatedWithTimer = useRef<string | null>(null);

  useEffect(() => {
    // Clear any existing timer when src changes or component re-evaluates.
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    // srcAssociatedWithTimer.current = null; // Reset this only when timer is cleared or src becomes null

    if (src) {
      const randomAnimation = ANIMATION_TYPES[Math.floor(Math.random() * ANIMATION_TYPES.length)];
      setCurrentImageDetails({
        key: `${src}-${Date.now()}`, // Unique key for re-animation
        url: src,
        animation: randomAnimation,
      });

      // Store the src for which this new timer is being set.
      const srcForThisTimerInstance = src;
      srcAssociatedWithTimer.current = srcForThisTimerInstance;

      hideTimerRef.current = window.setTimeout(() => {
        // Only hide if the currently active timer's src matches the src this timer was set for.
        if (srcAssociatedWithTimer.current === srcForThisTimerInstance) {
          setCurrentImageDetails(null); // Instantly hide
          srcAssociatedWithTimer.current = null; // Clear association as timer has fired
        }
      }, 2500); // Max display duration

    } else { // src prop is null, or became null
      setCurrentImageDetails(null); // Instantly hide
      srcAssociatedWithTimer.current = null; // Clear association
    }

    // Cleanup function for this effect (runs on unmount or before effect re-runs for new src)
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      // Do not nullify srcAssociatedWithTimer.current here if a timer is still potentially valid for it
      // It's mainly for the timeout callback to check against.
    };
  }, [src]); // Re-run only if src prop changes.

  if (!currentImageDetails) {
    return null; // Don't render anything if no image is active.
  }

  let animationClass = '';
  if (currentImageDetails.animation === 'pan-lr') animationClass = 'animate-pan-lr';
  else if (currentImageDetails.animation === 'pan-rl') animationClass = 'animate-pan-rl';
  else if (currentImageDetails.animation === 'zoom-in') animationClass = 'animate-zoom-in';

  return (
    <div
      className={`
        w-full h-full flex items-center justify-center
        bg-transparent /* Container is transparent, image itself will cover */
      `}
      aria-live="polite" 
      aria-hidden={false} // Container is present, image content dictates visibility
    >
      <img
        key={currentImageDetails.key}
        src={currentImageDetails.url}
        alt="Contextual content"
        className={`w-full h-full object-cover ${animationClass}`}
      />
    </div>
  );
};