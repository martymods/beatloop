import { createContext } from 'react';
import { Engine } from '../core/Engine';
import { AudioFileManager } from '../core/AudioFileManager';

export const EngineContext = createContext<Engine | null>(null);
export const AudioFileManagerContext = createContext(new AudioFileManager());
export const AudioContextContext = createContext<AudioContext | null>(null);
