import {AudioUnitBox, TrackBox} from "@opendaw/studio-boxes"
import {asInstanceOf, int, UUID} from "@opendaw/lib-std"
import {TrackType} from "@opendaw/studio-adapters"
import {Editing} from "@opendaw/lib-box"

export namespace RecordTrack {
    export const findOrCreate = (editing: Editing, audioUnitBox: AudioUnitBox, type: TrackType): TrackBox => {
        let index: int = 0 | 0
        for (const trackBox of audioUnitBox.tracks.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, TrackBox))) {
            const hasNoRegions = trackBox.regions.pointerHub.isEmpty()
            const acceptsNotes = trackBox.type.getValue() === type
            if (hasNoRegions && acceptsNotes) {return trackBox}
            index = Math.max(index, trackBox.index.getValue())
        }
        return editing.modify(() => TrackBox.create(audioUnitBox.graph, UUID.generate(), box => {
            box.type.setValue(type)
            box.index.setValue(index + 1)
            box.tracks.refer(audioUnitBox.tracks)
            box.target.refer(audioUnitBox)
        })).unwrap("Could not create TrackBox")
    }
}