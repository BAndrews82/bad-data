const roomManager = require('../lib/RoomManager');
const cardService = require('../lib/CardService');

async function testCahGameFlow() {
  console.log('====================================================');
  console.log(' Testing Bad Cards (Cards Against Humanity) Engine ');
  console.log('====================================================');

  // 1. Test Card Pack Discovery
  const availablePacks = cardService.getAvailablePacks();
  console.log(`[Test] Discovered ${availablePacks.length} card pack(s):`);
  availablePacks.forEach(p => console.log(`  - ${p.name} (${p.blackCount} Black, ${p.whiteCount} White)`));

  if (availablePacks.length === 0) {
    throw new Error('Expected at least 1 card pack in data/cards/');
  }

  // 2. Create Room & Select Game
  const room = roomManager.createRoom('host_socket_1');
  console.log(`\n[Test] Created room ${room.code}. Selected Game: ${room.selectedGameId}`);

  roomManager.selectGame(room.code, 'cah');
  console.log(`[Test] Switched game to: ${room.selectedGameId}`);

  // 3. Join 4 Players
  const p1 = roomManager.joinRoom(room.code, 'Alice', 'p1_socket');
  const p2 = roomManager.joinRoom(room.code, 'Bob', 'p2_socket');
  const p3 = roomManager.joinRoom(room.code, 'Charlie', 'p3_socket');
  const p4 = roomManager.joinRoom(room.code, 'Daisy', 'p4_socket');

  console.log(`[Test] Joined 4 players. Total: ${room.players.length}`);

  // 4. Setup Game
  await roomManager.setupGame(room.code, { enablePopularVote: true });
  console.log(`[Test] Game setup complete. Total rounds: ${room.totalRounds}, Popular Vote: ON`);

  // Check initial hands
  room.players.forEach(p => {
    console.log(`  - Player ${p.nickname} dealt ${p.hand.length} white cards.`);
    if (p.hand.length !== 7) throw new Error(`Expected 7 cards in hand for ${p.nickname}`);
  });

  // 5. Test Discard & Redraw Feature
  console.log('\n[Test] Testing Discard & Redraw Feature for Bob...');
  const redrawRes1 = roomManager.submitPlayerInput(room.code, 'p2_socket', { action: 'DISCARD_REDRAW', cardIndices: [0, 1, 2] });
  console.log(`[Test] Redraw 1 result: success=${redrawRes1.success}, hand size=${redrawRes1.hand.length}`);
  if (!redrawRes1.success || redrawRes1.hand.length !== 7) {
    throw new Error('Discard & Redraw failed!');
  }

  // Attempt 2nd Redraw (should fail)
  const redrawRes2 = roomManager.submitPlayerInput(room.code, 'p2_socket', { action: 'DISCARD_REDRAW', cardIndices: [0, 1, 2] });
  console.log(`[Test] Redraw 2 attempt (should fail): error="${redrawRes2.error}"`);
  if (!redrawRes2.error) {
    throw new Error('Second Discard & Redraw should have failed!');
  }

  // 6. Run Round 1
  const round1 = roomManager.startRound(room.code);
  console.log(`\n[Round 1] Prompt: "${round1.prompt}". Judge: ${round1.judgeNickname}`);

  const nonJudgeSockets = room.players.filter(p => p.socketId !== round1.judgeSocketId).map(p => p.socketId);

  // Submit cards
  let subRes = roomManager.submitPlayerInput(room.code, nonJudgeSockets[0], { action: 'SUBMIT_CARD', cardIndex: 0 });
  subRes = roomManager.submitPlayerInput(room.code, nonJudgeSockets[1], { action: 'SUBMIT_CARD', cardIndex: 0 });
  subRes = roomManager.submitPlayerInput(room.code, nonJudgeSockets[2], { action: 'SUBMIT_CARD', cardIndex: 0 });

  if (!subRes.allSubmitted || room.status !== 'CAH_JUDGE') {
    throw new Error('Expected allSubmitted and CAH_JUDGE state!');
  }

  console.log(`[Test] Anonymous Shuffled Submissions count: ${room.shuffledSubmissions.length}`);

  // Test Popular Voting from non-judge players
  const subToVote = room.shuffledSubmissions[0].id;
  const voteRes = roomManager.submitPlayerInput(room.code, nonJudgeSockets[0], { action: 'POPULAR_VOTE', submissionId: subToVote });
  console.log(`[Test] Popular vote cast: success=${voteRes.success}, totalVotes=${voteRes.totalVotesCast}`);

  // Judge picks winner
  const judgeRes = roomManager.submitPlayerInput(room.code, round1.judgeSocketId, { action: 'PICK_WINNER', submissionId: subToVote });
  console.log(`[Test] Judge picked winner: "${judgeRes.winningSubmission.cardText}" (Winner: ${judgeRes.winnerPlayer.nickname}, Popular Winner: ${judgeRes.popularWinnerPlayer?.nickname || 'None'})`);

  if (room.status !== 'CAH_REVEAL') {
    throw new Error(`Expected room status CAH_REVEAL, got ${room.status}`);
  }

  if (!judgeRes.popularWinnerPlayer) {
    throw new Error('Expected a Popular Winner to be calculated!');
  }

  // 7. Test Judge Reconnection Socket ID Update
  console.log('\n[Test] Testing Judge Reconnection...');
  const reconnectRes = roomManager.reconnectPlayer(room.code, p1.player.sessionToken, 'p1_new_socket');
  if (room.currentJudgeSocketId !== 'p1_new_socket') {
    throw new Error(`Expected room.currentJudgeSocketId to be updated to p1_new_socket, got ${room.currentJudgeSocketId}`);
  }
  console.log('  - Reconnection updated judgeSocketId successfully:', room.currentJudgeSocketId);

  // 8. Test Auto-Submission & Auto-Pick (Timeout resilience)
  console.log('\n[Test] Testing Auto-Submission & Auto-Pick resilience...');
  roomManager.advanceNextRound(room.code);
  const round2 = roomManager.startRound(room.code);
  console.log(`[Round 2] Prompt: "${round2.prompt}". Judge: ${round2.judgeNickname}`);
  
  // Simulate only 1 player submitting, then auto-submitting remaining
  const nonJudgesR2 = room.players.filter(p => p.socketId !== round2.judgeSocketId);
  roomManager.submitPlayerInput(room.code, nonJudgesR2[0].socketId, { action: 'SUBMIT_CARD', cardIndex: 0 });
  
  // Call autoSubmitRemaining
  room.gameEngine.autoSubmitRemaining(room);
  if (room.status !== 'CAH_JUDGE') {
    throw new Error(`Expected room status CAH_JUDGE after autoSubmitRemaining, got ${room.status}`);
  }
  console.log('  - Auto-submit completed successfully. Shuffled submissions count:', room.shuffledSubmissions.length);

  // Auto-pick winner
  const autoPickRes = room.gameEngine.autoPickWinner(room);
  if (!autoPickRes || room.status !== 'CAH_REVEAL' || !autoPickRes.winningSubmission) {
    throw new Error('Expected autoPickWinner to transition to CAH_REVEAL and pick a winner!');
  }
  console.log(`  - Auto-pick completed successfully: "${autoPickRes.winningSubmission.cardText}" (Winner: ${autoPickRes.winnerPlayer.nickname})`);

  // 9. Test White Deck Replenishment
  console.log('\n[Test] Testing Deck Replenishment...');
  room.whiteDeck = []; // artificially empty deck
  const drawn = room.gameEngine.drawWhiteCard(room);
  if (!drawn || typeof drawn !== 'string') {
    throw new Error('Expected drawWhiteCard to replenish from discard pile or packs!');
  }
  console.log(`  - Successfully drew from replenished deck: "${drawn}"`);

  // 10. Test Round 3 with Configurable Target Score (Target: 2) & Targeted Discard Redraw
  console.log('\n[Test] Testing Round 3 with Configurable Target Score (Target: 2)...');
  room.targetScore = 2;
  const targetWinner = room.players[0];
  targetWinner.score = 1; // 1 pt away from target

  roomManager.advanceNextRound(room.code);
  const round3 = roomManager.startRound(room.code);
  console.log(`[Round 3] Prompt: "${round3.prompt}". Judge: ${round3.judgeNickname}`);

  // Test Targeted Discard Redraw with Deduplication during CAH_SUBMIT
  const nonJudgesR3 = room.players.filter(p => p.socketId !== round3.judgeSocketId);
  const redrawPlayer = nonJudgesR3.find(p => !p.usedRedraw);
  if (redrawPlayer) {
    console.log(`\n[Test] Testing Targeted Discard Redraw with Deduplication for ${redrawPlayer.nickname}...`);
    const redrawRes3 = roomManager.submitPlayerInput(room.code, redrawPlayer.socketId, { action: 'DISCARD_REDRAW', cardIndices: [4, 4, 1] });
    if (!redrawRes3.success || redrawRes3.hand.length !== 7) {
      throw new Error(`Targeted Discard Redraw failed! Expected 7 cards, got ${redrawRes3.hand?.length}`);
    }
    console.log('  - Targeted discard & redraw handled deduplicated indices cleanly.');
  }

  // Submit cards
  nonJudgesR3.forEach(p => {
    roomManager.submitPlayerInput(room.code, p.socketId, { action: 'SUBMIT_CARD', cardIndex: 0 });
  });

  // Pick winner to trigger game over
  // Ensure targetWinner is a submission, or if targetWinner is judge, award winner to reached target
  const winnerSub = room.shuffledSubmissions.find(s => s.playerSocketId === targetWinner.socketId) || room.shuffledSubmissions[0];
  if (winnerSub.playerSocketId !== targetWinner.socketId) {
    const actualSubPlayer = room.players.find(p => p.socketId === winnerSub.playerSocketId);
    if (actualSubPlayer) actualSubPlayer.score = 1;
  }

  const round3JudgeRes = roomManager.submitPlayerInput(room.code, round3.judgeSocketId, { action: 'PICK_WINNER', submissionId: winnerSub.id });
  
  console.log(`  - Round 3 Winner: ${round3JudgeRes.winnerPlayer.nickname} with ${round3JudgeRes.winnerPlayer.score} pts.`);
  console.log(`  - isGameOver flag: ${round3JudgeRes.isGameOver} (Target: ${room.targetScore})`);

  if (!round3JudgeRes.isGameOver) {
    throw new Error(`Expected isGameOver to be true when player reached targetScore ${room.targetScore}!`);
  }

  console.log('\n✅ Bad Cards Engine & Extended Features Test Passed Successfully!');
  process.exit(0);
}

testCahGameFlow().catch(err => {
  console.error('❌ Test Failed:', err);
  process.exit(1);
});
