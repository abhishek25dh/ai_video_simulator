
import React, { useRef } from 'react';

interface FileUploadProps {
  label: string; 
  onFileUpload: (file: File) => void;
  accept: string;
  currentFile: File | null;
  previewSrc?: string | null;
  isRequired?: boolean; // More accurately: "is this input method required if no other source is provided?"
}

export const FileUpload: React.FC<FileUploadProps> = ({ 
  label, 
  onFileUpload, 
  accept, 
  currentFile, 
  previewSrc,
  isRequired = false 
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files[0]) {
      onFileUpload(event.target.files[0]);
    }
  };

  const triggerFileInput = () => {
    inputRef.current?.click();
  };

  return (
    <div className="mb-3"> {/* Removed bg-gray-700 p-3 shadow from here, parent div in App.tsx now handles this styling */}
      <label className="block text-xs font-medium text-gray-300 mb-0.5">{label}</label>
      <div className="flex items-center space-x-2">
        <button
          type="button"
          onClick={triggerFileInput}
          className="px-3 py-1.5 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-md transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 focus:ring-offset-gray-800"
          aria-label={`Select or change file for ${label}`}
        >
          {currentFile ? 'Change File' : 'Select File'}
        </button>
        <input
          type="file"
          ref={inputRef}
          onChange={handleFileChange}
          accept={accept}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />
        {currentFile && (
          <span className="text-xs text-gray-400 truncate max-w-[150px] flex-shrink min-w-0">
            {currentFile.name}
          </span>
        )}
      </div>
      {previewSrc && accept.startsWith('image/') && (
        <div className="mt-2">
          <img src={previewSrc} alt={`${label} preview`} className="h-16 w-auto object-contain rounded-md border border-gray-600" />
        </div>
      )}
       {!currentFile && isRequired && ( 
         <p className="text-xs text-yellow-400 mt-1">Required if no other source (URL/Preset) is active.</p>
       )}
       {!currentFile && !isRequired && (
         <p className="text-xs text-gray-500 mt-1">Optional</p>
       )}
    </div>
  );
};
