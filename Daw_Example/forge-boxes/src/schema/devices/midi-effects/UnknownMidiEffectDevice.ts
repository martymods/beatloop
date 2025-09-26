import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {createMidiEffectDevice} from "../builder"

export const UnknownMidiEffectDevice: BoxSchema<Pointers> = createMidiEffectDevice("UnknownMidiEffectDeviceBox", {
    10: {type: "string", name: "comment"}
})