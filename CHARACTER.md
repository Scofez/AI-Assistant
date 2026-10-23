# Avatar character: Mochi (original design)

An original anime maid. Small, tidy, a little serious, quietly proud when work is done. She is your terminal's housekeeper.

## Look

- **Body:** chibi proportions, head about 40% of total height. 64×64 frame, character about 52 px tall, feet on the bottom row with 2 px margin.
- **Hair:** ash-blonde, chin-length bob with two small side buns tied with mint ribbons. One short ahoge (stray hair strand) that reacts to states.
- **Eyes:** large teal eyes with a 1 px white highlight.
- **Outfit:** navy maid dress, white apron with a frilled edge, white collar, small mint bow at the neck, white headband with frills.
- **Accessory:** a tiny headset with a mic on the left side. This is her "agent" detail.
- **Prop:** a small feather duster, used in the `working` and `done` animations.

## Palette (16 colors max)

| Role | Hex |
|---|---|
| Outline | #1B1A2E |
| Skin | #F7D9C4 |
| Skin shadow | #E0B39B |
| Hair | #D8CFB8 |
| Hair shadow | #A99F88 |
| Eyes | #2BB3A3 |
| Eye dark | #146E66 |
| Dress | #2A3A6B |
| Dress shadow | #1C274A |
| Apron / white | #F4F6FA |
| Apron shadow | #C9CEDB |
| Ribbon / mint | #7FE0C4 |
| Headset | #5A5F73 |
| Blush | #F29AA8 |
| Sparkle | #FFE27A |
| Alert | #FF8A3D |

## States

| State | Pose and effects |
|---|---|
| idle | Stands straight, hands folded on apron. Slow breathing (1 px up/down). Blink every few seconds. |
| thinking | Finger on chin, eyes look up. Small `?` or `...` above head. Ahoge sways. |
| working | Dusts quickly with the feather duster. Small dust puffs. Focused eyes. |
| attention | Raises one hand, small hop. Orange `!` above head. Headset mic glows. |
| done | Neat curtsy, then a small smile with closed happy eyes. Two or three yellow sparkles. |
| sleeping | Sits on the floor, head tilted, eyes closed. `z` floats up. |
| greet | Small bow, then a wave. |
| talking (overlay) | Mouth only: closed / open. Same position in every state. |

## Prompt for an AI pixel-art tool (optional)

Use this if you want to generate art with an image tool, then clean it up in Aseprite or Piskel.

> Pixel art sprite sheet of an original chibi anime maid character, 64×64 pixels per frame, transparent background, 1-pixel dark outline, limited 16-color palette, clean readable silhouette, no anti-aliasing. Ash-blonde chin-length bob with two small side buns tied with mint ribbons, one stray hair strand on top, large teal eyes, navy maid dress, white frilled apron and headband, small mint bow at the neck, tiny gray headset with a mic, holding a small feather duster. Front-facing 3/4 pose. Horizontal strip of frames for the "{STATE}" animation: {POSE DESCRIPTION FROM THE TABLE ABOVE}. Same character, same size and position in every frame.

Generate one strip per state. Keep the character in the same place in every frame, so the states switch without a jump.
