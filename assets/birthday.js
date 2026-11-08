/*
 * Birthday edition settings. Everything the game says about the birthday boy
 * comes from here, so you can change the words without touching game.js.
 * Set window.AWF_BIRTHDAY = null to get the plain game back.
 */
window.AWF_BIRTHDAY = {
  name: 'Sakaar',

  // Typed out line by line under the birthday banner at the end.
  message: [
    'In this game you always win.',
    'With me, you always will.',
    'Happy birthday, Sakaar.',
  ],

  // The sign the crowd holds up. (arenaBanner would replace the wall sign's text; null keeps the original.)
  arenaBanner: null,
  crowdSign: 'HBD SAKAAR',

  // Music for his victory dance. null plays the built-in Bollywood-style dance number
  // (dhol beat, tabla fills and a shehnai-style lead, all synthesised). To use a real
  // song you have the rights to, put the file in assets/ and set e.g. 'assets/dance.mp3'.
  danceTrack: null,

  // Start screen line under the title.
  tagline: "A game where you can't lose. Just like us.",

  // What the Challenger says when she fails (she is, after all, letting him win).
  lines: {
    trip: 'distracted by you!',
    tired: "you're exhausting... in a good way",
    whiff: 'I let you have that one',
    sneeze: 'allergic to losing to you',
    plot: 'LOVE ARMOR!',
    heroTagline: 'Undefeated. Unbothered. Loved.',
    challengerTagline: 'Has lost to him every single day. Happily.',
    round: ["let's see what you've got", 'still yours', 'the one that matters'],
    stats: [
      ['Rounds won', 'All of them'],
      ['Damage taken', "None. I've got you."],
      ['Challenger vs Sakaar', '0 wins, and counting'],
      ['Fight time', 'Forever'],
    ],
  },

  // What she says during the fight (speech bubbles). One is picked at random.
  flirts: {
    idle: ['you look good when you win', "I'd let you win anyway", 'nice jacket', 'is it hot in here?', 'come here, you', 'stop smiling, I\'m trying to fight'],
    attack: ['catch me if you can', 'is that all?', 'think fast, handsome', 'this one\'s a love tap'],
    kiss: ['mwah!', 'that counts as a hit', 'one for luck', 'kisses are legal, I checked'],
    landed: ['oops, did that hurt? sorry not sorry', 'that was a love tap', "don't worry, I'll kiss it better"],
    gotHit: ["ow! you're strong", 'rude... I like it', 'do that again', "okay, that's fair"],
    block: ['nice try, handsome', 'not today, love', 'I know all your moves'],
    down: ['I meant to do that', 'the floor is comfy, actually', 'just resting my eyes'],
    lowHp: ['okay okay, you win', 'you always do', "I'm not even mad"],
    flip: ['like what you see?', "this hair doesn't flip itself", 'eyes up here, champ'],
    jump: ['nice jump', 'show-off', 'ooh, athletic'],
    heroBlock: ['playing hard to get?', "you can't block a kiss", 'so shy'],
    heroIdle: ['are you just going to stand there?', "I'm right here, you know", 'take your time, handsome'],
    lovestruck: ['gotcha', 'told you I know your moves', 'look at that face'],
    flustered: ["oh no, he's cute", 'wait, that\'s cheating', 'do NOT do that again... please do'],
  },

  // What he says back (sometimes) when she chats to him.
  replies: ['I know.', "focus, we're fighting", 'you first', "that's my line", "stop, I'm blushing", 'after this round'],

  // Secret screen: press H during the game. Put a photo of the two of you in
  // assets/ and set its path here, for example 'assets/us.jpg'. With null, the
  // secret screen shows the message on a heart card instead.
  photo: null,
  photoCaption: 'Still my favourite opponent.',
};
