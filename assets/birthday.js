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

  // The big sign on the arena wall and the sign the crowd holds up.
  arenaBanner: 'SAKAAR ALWAYS WINS',
  crowdSign: 'HBD SAKAAR',

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
  },

  // Secret screen: press H during the game. Put a photo of the two of you in
  // assets/ and set its path here, for example 'assets/us.jpg'. With null, the
  // secret screen shows the message on a heart card instead.
  photo: null,
  photoCaption: 'Still my favourite opponent.',
};
