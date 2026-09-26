/**
 * Cap on a name in the status bar that has no shrink mechanism of its own (the
 * profile name, the injected Bundle name). It grows with the window, so a long
 * name is cut off in a narrow window but shown in full in a wide one.
 */
export const NAME_CAP = "clamp(140px, 15vw, 320px)";
