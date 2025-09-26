import {Schema} from "@opendaw/lib-std"

export const EngineStateSchema = Schema.createBuilder({
    position: Schema.float,
    playbackTimestamp: Schema.float,
    countInBeatsRemaining: Schema.float,
    countInBeatsTotal: Schema.float,
    isPlaying: Schema.bool,
    isCountingIn: Schema.bool,
    isRecording: Schema.bool
})

export type EngineState = ReturnType<typeof EngineStateSchema>["object"]