import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {createAudioEffectDevice} from "../builder"

export const UnknownAudioEffectDevice: BoxSchema<Pointers> = createAudioEffectDevice("UnknownAudioEffectDeviceBox", {
    10: {type: "string", name: "comment"}
})