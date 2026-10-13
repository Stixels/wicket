/**
 * The emoji the picker offers, with words to search them by. Kept small on purpose: the ones a
 * support team reaches for, not all 3,700. They're plain Unicode, so each device draws them in its
 * own style (Apple, Google, Microsoft), the same way the user and Discord will see them.
 */
const DATA = `
Smileys
😀 smile happy grin
😄 smile happy laugh
😁 grin beam
😊 blush happy warm
🙂 slight smile ok
😉 wink
😍 love heart eyes
🥰 love hearts adore
😘 kiss
😎 cool sunglasses
🤩 star struck wow
🥳 party celebrate
😂 laugh tears joy lol
🤣 rofl laugh
😅 sweat relief phew
😆 laugh squint
🙃 upside down silly
😇 angel innocent
🤗 hug thanks
🤔 thinking hmm
🤨 raised eyebrow skeptical
😐 neutral meh
😶 speechless
🙄 eye roll
😬 grimace awkward oops
😮 surprised wow
😲 astonished shocked
😳 flushed embarrassed
🥺 pleading please
😢 sad cry tear
😭 sob crying
😤 frustrated huff
😡 angry mad
🤯 mind blown
😴 sleep tired
🤒 sick ill
🤓 nerd geek
🧐 monocle inspect
😵 dizzy confused
🫡 salute ok yes
🫠 melting
People
👍 thumbs up yes ok approve like
👎 thumbs down no dislike
👌 ok perfect
✌️ peace victory
🤞 fingers crossed hope luck
👏 clap applause bravo
🙌 raise hands celebrate hooray
👋 wave hello hi bye
🙏 pray thanks please
💪 strong muscle
🤝 handshake deal agree
👀 eyes looking watching
🫶 heart hands love
✋ stop hand high five
👉 point right
👆 point up
🤷 shrug dunno
🤦 facepalm
🙋 raise hand question
🧑‍💻 developer coder laptop
Hearts
❤️ heart love red
🧡 heart orange
💛 heart yellow
💚 heart green
💙 heart blue
💜 heart purple
🖤 heart black
🤍 heart white
💔 broken heart
💯 hundred perfect
Objects
🎉 party tada celebrate congrats
🎊 confetti celebrate
🎁 gift present
🏆 trophy win
⭐ star favorite
✨ sparkles new magic
🔥 fire hot lit
⚡ lightning fast zap
💡 idea bulb tip
🐛 bug issue error
🛠️ tools fix build
🔧 wrench fix settings
⚙️ gear settings config
🚀 rocket launch ship release
📦 package box shipped
🔒 lock secure private
🔓 unlock open
🔑 key password access
📎 paperclip attachment
📸 camera screenshot photo
🖼️ picture image
🎥 video camera record
📹 video recording
💻 laptop computer
🖥️ desktop computer screen
📱 phone mobile
⌨️ keyboard
🖱️ mouse
🔌 plug power
🔋 battery
📡 signal network
🌐 web globe internet
📊 chart stats analytics
📈 chart up growth
📉 chart down decline
📅 calendar date
⏰ alarm clock time
⏱️ stopwatch timer
⏳ hourglass waiting
📝 memo note write
📌 pin important
🔍 search magnify
📚 docs books
📖 book read guide
✉️ email mail envelope
📣 announce megaphone
🔔 bell notification
🎮 game controller
🧩 puzzle piece
🚪 door escape room
🗝️ old key escape
🎟️ ticket booking
☕ coffee break
🍕 pizza
Symbols
✅ check done yes complete
☑️ checkbox done
✔️ check mark
❌ cross no wrong
❎ cross no
⚠️ warning caution
🚫 forbidden no
⛔ stop no entry
❗ exclamation important
❓ question
❔ question white
‼️ double exclamation
💬 speech chat message
💭 thought bubble
🗨️ comment
➡️ right arrow next
⬅️ left arrow back
⬆️ up arrow
⬇️ down arrow
🔄 refresh sync retry
🔁 repeat loop
➕ plus add
➖ minus remove
🆕 new
🆗 ok
🆘 sos help
🟢 green circle online
🟡 yellow circle away
🔴 red circle offline busy
🔵 blue circle
⚪ white circle
`;

export interface Emoji {
  char: string;
  words: string;
  group: string;
}

export const EMOJI: Emoji[] = [];
export const GROUPS: string[] = [];
{
  let group = "";
  for (const line of DATA.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const [char, ...words] = t.split(" ");
    if (!words.length) {
      group = char!;
      GROUPS.push(group);
    } else {
      EMOJI.push({ char: char!, words: words.join(" "), group });
    }
  }
}

/** Emoji whose words start with every word typed, e.g. "thu up" finds 👍. */
export function searchEmoji(query: string): Emoji[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return EMOJI;
  return EMOJI.filter((e) => {
    const words = e.words.split(" ");
    return terms.every((t) => words.some((w) => w.startsWith(t)));
  });
}

const RECENT_KEY = "wicket-team-emoji";

export function recentEmoji(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]").slice(0, 16);
  } catch {
    return [];
  }
}

export function rememberEmoji(char: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([char, ...recentEmoji().filter((c) => c !== char)].slice(0, 16)));
  } catch {}
}
