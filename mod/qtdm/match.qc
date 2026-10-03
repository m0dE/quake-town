/*
	match.qc

	Modes (serverinfo "mode"), warmup + ready-up, countdown, timelimit /
	fraglimit / overtime, intermission and the map rotation.

	Copyright (C) 2026 Quake Town contributors

	This program is free software; you can redistribute it and/or
	modify it under the terms of the GNU General Public License
	as published by the Free Software Foundation; either version 2
	of the License, or (at your option) any later version.

	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
*/

void() execute_changelevel;
entity() FindIntermission;
void() CA_Frame;
void() CA_RoundBreakFrame;
void() CA_StartMatch;
float(entity a, entity b) SameTeam;
string(float t) TeamTitle;
float(float t, entity ignore) Team_Count;

float   COUNTDOWN_TIME = 10;
float   INTERMISSION_TIME = 8;

// serverinfo value, or "" when the key is missing
float(string key, float def) InfoFloat =
{
	local string s;

	s = infokey (world, key);
	if (s == "")
		return def;
	return stof (s);
};

/*
============
QT_InitMode

worldspawn: reads serverinfo, fixes the rules of the mode, resets the
match. Everything is reset here explicitly, so the mod does not depend on
the engine reloading the progs globals on a map change.
============
*/
void() QT_InitMode =
{
	local string s;
	local float tl, fl;

	s = infokey (world, "mode");
	qt_mode = MODE_FFA;
	if (s == "duel" || s == "1on1")
		qt_mode = MODE_DUEL;
	else if (s == "2on2")
		qt_mode = MODE_2ON2;
	else if (s == "4on4")
		qt_mode = MODE_4ON4;
	else if (s == "ctf")
		qt_mode = MODE_CTF;
	else if (s == "ca")
		qt_mode = MODE_CA;

	qt_teammode = FALSE;
	qt_readyup = TRUE;
	qt_noitems = FALSE;
	fl = 0;
	if (qt_mode == MODE_FFA)
	{
		mode_name = "Free For All";
		deathmatch = 3; teamplay = 0; tl = 15; fl = 30;
		qt_readyup = FALSE;
	}
	else if (qt_mode == MODE_DUEL)
	{
		mode_name = "Duel";
		deathmatch = 3; teamplay = 0; tl = 10;
	}
	else if (qt_mode == MODE_2ON2)
	{
		mode_name = "2on2";
		deathmatch = 3; teamplay = 2; tl = 10;
		qt_teammode = TRUE;
	}
	else if (qt_mode == MODE_4ON4)
	{
		mode_name = "4on4";
		deathmatch = 1; teamplay = 2; tl = 20;
		qt_teammode = TRUE;
	}
	else if (qt_mode == MODE_CTF)
	{
		mode_name = "Capture The Flag";
		deathmatch = 3; teamplay = 1; tl = 20;
		qt_teammode = TRUE;
	}
	else
	{
		mode_name = "Clan Arena";
		deathmatch = 3; teamplay = 1; tl = 0;
		qt_teammode = TRUE;
		qt_noitems = TRUE;
	}

	// the host's timelimit (minutes) / fraglimit win over the mode's
	timelimit = InfoFloat ("timelimit", tl) * 60;
	fraglimit = InfoFloat ("fraglimit", fl);
	if (qt_mode == MODE_CA)
		timelimit = 0;          // Clan Arena is played in rounds

	overtime_sd = FALSE;
	overtime_len = 3 * 60;
	s = infokey (world, "overtime");
	if (s == "sd")
		overtime_sd = TRUE;
	else if (s != "")
		overtime_len = stof (s) * 60;

	capturelimit = InfoFloat ("capturelimit", 0);
	ca_roundlimit = InfoFloat ("rounds", 7);
	if (ca_roundlimit < 1)
		ca_roundlimit = 7;
	ca_roundtime = InfoFloat ("roundtime", 300);

	cvar_set ("deathmatch", ftos (deathmatch));
	cvar_set ("teamplay", ftos (teamplay));
	cvar_set ("timelimit", ftos (timelimit / 60));
	cvar_set ("fraglimit", ftos (fraglimit));

	framecount = 0;
	overtime_count = 0;
	selftest_step = 0;
	rj = 1;                 // rocket jump modifier, serverinfo "rj" (client.qc)

	// match state
	intermission_running = 0;
	intermission_exittime = 0;
	changelevel_sent = FALSE;
	team1score = team2score = 0;
	team1caps = team2caps = 0;
	ca_round = 0;
	countdown_last = 0;
	no_telefrag = FALSE;
	flag_red = flag_blue = world;
	warmup_hint_time = 0;
	match_countdownend = 0;
	if (qt_readyup)
	{
		match_phase = PHASE_WARMUP;
		match_starttime = 0;
		match_endtime = 0;
	}
	else
	{
		match_phase = PHASE_PLAYING;
		match_starttime = time;
		match_endtime = 0;
		if (timelimit)
			match_endtime = time + timelimit;
	}
	state_dirty = TRUE;

	precache_sound ("buttons/switch04.wav");        // countdown tick
	precache_sound ("misc/runekey.wav");            // capture
	precache_sound ("misc/medkey.wav");             // flag taken
	precache_sound ("doors/runetry.wav");           // flag returned
	precache_sound ("items/itembk2.wav");
	if (qt_mode == MODE_CTF)
		precache_model (QT_FLAG_MODEL);
};

/*
============
QT_SendState

qt_matchstate: phase, end time, countdown end, scores, round.
Scores: team frags (2on2/4on4), captures (CTF), rounds won (CA),
the two players' frags (duel), 0 (FFA).
============
*/
void() QT_SendState =
{
	local float s1, s2;
	local entity p, a, b;

	s1 = team1score;
	s2 = team2score;
	if (qt_mode == MODE_CTF)
	{
		s1 = team1caps;
		s2 = team2caps;
	}
	else if (qt_mode == MODE_FFA)
	{
		s1 = s2 = 0;
	}
	else if (qt_mode == MODE_DUEL)
	{
		a = b = world;
		p = find (world, classname, "player");
		while (p)
		{
			if (p.qt_connected)
			{
				if (!a)
					a = p;
				else if (!b)
					b = p;
			}
			p = find (p, classname, "player");
		}
		s1 = a.frags;
		s2 = b.frags;
	}
	qt_matchstate (match_phase, match_endtime, match_countdownend, s1, s2, ca_round);
	state_dirty = FALSE;
};

void(string s) CenterAll =
{
	local entity p;

	p = find (world, classname, "player");
	while (p)
	{
		if (p.qt_connected)
			centerprint (p, s);
		p = find (p, classname, "player");
	}
};

float() Match_PlayerCount =
{
	local entity p;
	local float n;

	n = 0;
	p = find (world, classname, "player");
	while (p)
	{
		if (p.qt_connected)
			n = n + 1;
		p = find (p, classname, "player");
	}
	return n;
};

// enough players for a match
float() Match_CanStart =
{
	if (qt_mode == MODE_DUEL)
		return Match_PlayerCount () >= 2;
	if (qt_teammode)
	{
		if (Team_Count (TEAM_RED, world) < 1)
			return FALSE;
		if (Team_Count (TEAM_BLUE, world) < 1)
			return FALSE;
		return TRUE;
	}
	return Match_PlayerCount () >= 1;
};

float() Match_AllReady =
{
	local entity p;

	p = find (world, classname, "player");
	while (p)
	{
		if (p.qt_connected && !p.qt_ready && !qt_isbot (p))
			return FALSE;
		p = find (p, classname, "player");
	}
	return TRUE;
};

float() Match_CanFire =
{
	if (match_phase == PHASE_COUNTDOWN || match_phase == PHASE_INTERMISSION ||
		match_phase == PHASE_ROUNDBREAK)
		return FALSE;
	return TRUE;
};

float() Match_DamageAllowed =
{
	return Match_CanFire ();
};

/*
============
Match_ResetWorld

Match start: every item back, projectiles, packs and dropped powerups gone,
flags home.
============
*/
void() Match_ResetWorld =
{
	local entity e, next;

	e = nextent (world);
	while (e)
	{
		next = nextent (e);
		if (e.classname == "backpack" || e.classname == "dropped_powerup" ||
			e.classname == "rocket" || e.classname == "grenade" ||
			e.classname == "spike" || e.classname == "teledeath")
		{
			remove (e);
		}
		else if ((e.flags & FL_ITEM) && e.mdl != "" && !e.flagteam)
		{
			if (e.model == "" || e.think == item_megahealth_rot)
			{
				e.model = e.mdl;
				e.solid = SOLID_TRIGGER;
				setorigin (e, e.origin);
				e.think = SUB_Null;
				e.nextthink = 0;
			}
		}
		e = next;
	}
	CTF_ResetFlags ();
};

// everyone respawns at a spawn point with a fresh kit, no telefrags
void() Match_RespawnAll =
{
	local entity p, oself;

	oself = self;
	no_telefrag = TRUE;
	p = find (world, classname, "player");
	while (p)
	{
		if (p.qt_connected)
		{
			self = p;
			self.ctf_teamspawn = TRUE;
			SetNewParms ();
			PutClientInServer ();
		}
		p = find (p, classname, "player");
	}
	no_telefrag = FALSE;
	self = oself;
};

void() Match_StartCountdown =
{
	match_phase = PHASE_COUNTDOWN;
	match_countdownend = time + COUNTDOWN_TIME;
	countdown_last = 0;
	bprint (PRINT_HIGH, "All players ready: the match starts in 10 seconds\n");
	state_dirty = TRUE;
};

void() Match_AbortCountdown =
{
	match_phase = PHASE_WARMUP;
	match_countdownend = 0;
	bprint (PRINT_HIGH, "Countdown aborted\n");
	CenterAll ("");
	state_dirty = TRUE;
};

void() Match_Start =
{
	local entity p;

	team1score = team2score = 0;
	team1caps = team2caps = 0;
	ca_round = 0;
	Match_ResetWorld ();

	p = find (world, classname, "player");
	while (p)
	{
		if (p.qt_connected)
		{
			p.frags = 0;
			p.qt_break = FALSE;
			p.ctf_lastreturn = p.ctf_lastcarrierfrag = -100;
			Stat_ResetPlayer (p);
		}
		p = find (p, classname, "player");
	}

	// respawn before the phase changes (a CA respawn during a round is a ghost)
	Match_RespawnAll ();

	match_phase = PHASE_PLAYING;
	match_starttime = time;
	overtime_count = 0;
	match_countdownend = 0;
	match_endtime = 0;
	if (timelimit)
		match_endtime = time + timelimit;

	bprint (PRINT_HIGH, "The match has begun!\n");
	CenterAll ("FIGHT!");
	if (qt_mode == MODE_CA)
		CA_StartMatch ();
	state_dirty = TRUE;
};

/*
============
Match_Stop

"break" by most humans during a match: back to warmup.
============
*/
void() Match_Stop =
{
	local entity p;

	match_phase = PHASE_WARMUP;
	match_endtime = 0;
	match_countdownend = 0;
	ca_round = 0;
	p = find (world, classname, "player");
	while (p)
	{
		if (p.qt_connected)
		{
			p.qt_ready = qt_isbot (p);
			p.qt_break = FALSE;
		}
		p = find (p, classname, "player");
	}
	Match_ResetWorld ();
	Match_RespawnAll ();
	bprint (PRINT_HIGH, "The match was stopped: warmup\n");
	state_dirty = TRUE;
};

// leader on time / tie test
float() Match_IsTie =
{
	local entity p;
	local float best, second, n;

	if (qt_mode == MODE_CTF)
		return team1caps == team2caps;
	if (qt_teammode)
		return team1score == team2score;

	n = 0;
	best = second = -99999;
	p = find (world, classname, "player");
	while (p)
	{
		if (p.qt_connected)
		{
			n = n + 1;
			if (p.frags > best)
			{
				second = best;
				best = p.frags;
			}
			else if (p.frags > second)
				second = p.frags;
		}
		p = find (p, classname, "player");
	}
	if (n < 2)
		return FALSE;
	return best == second;
};

void(entity p) Match_PrintPlayer =
{
	local float acc;

	bprint (PRINT_HIGH, p.netname);
	if (p.qteam)
	{
		bprint (PRINT_HIGH, " (");
		bprint (PRINT_HIGH, TeamName (p.qteam));
		bprint (PRINT_HIGH, ")");
	}
	bprint (PRINT_HIGH, ": ");
	bprint (PRINT_HIGH, ftos (p.frags));
	bprint (PRINT_HIGH, " frags, ");
	bprint (PRINT_HIGH, ftos (p.st_kills));
	bprint (PRINT_HIGH, " kills, ");
	bprint (PRINT_HIGH, ftos (p.st_deaths));
	bprint (PRINT_HIGH, " deaths, eff ");
	bprint (PRINT_HIGH, ftos (p.st_eff));
	bprint (PRINT_HIGH, "%");
	if (p.st_rl_shots)
	{
		bprint (PRINT_HIGH, ", rl ");
		bprint (PRINT_HIGH, ftos (p.st_rl_hits));
		bprint (PRINT_HIGH, "/");
		bprint (PRINT_HIGH, ftos (p.st_rl_shots));
	}
	if (p.st_lg_shots)
	{
		acc = rint (p.st_lg_hits * 100 / p.st_lg_shots);
		bprint (PRINT_HIGH, ", lg ");
		bprint (PRINT_HIGH, ftos (acc));
		bprint (PRINT_HIGH, "%");
	}
	bprint (PRINT_HIGH, ", dmg ");
	bprint (PRINT_HIGH, ftos (p.st_dmg_given));
	bprint (PRINT_HIGH, "\n");
};

void() Match_PrintResults =
{
	local entity p, best;
	local float s1, s2;

	bprint (PRINT_HIGH, "\n== Match over ==\n");
	if (qt_teammode)
	{
		s1 = team1score;
		s2 = team2score;
		if (qt_mode == MODE_CTF)
		{
			s1 = team1caps;
			s2 = team2caps;
		}
		bprint (PRINT_HIGH, "RED ");
		bprint (PRINT_HIGH, ftos (s1));
		bprint (PRINT_HIGH, " : ");
		bprint (PRINT_HIGH, ftos (s2));
		bprint (PRINT_HIGH, " BLUE");
		if (qt_mode == MODE_CTF)
			bprint (PRINT_HIGH, " (captures)");
		if (qt_mode == MODE_CA)
			bprint (PRINT_HIGH, " (rounds)");
		bprint (PRINT_HIGH, "\n");
		if (s1 > s2)
			bprint (PRINT_HIGH, "RED wins the match!\n");
		else if (s2 > s1)
			bprint (PRINT_HIGH, "BLUE wins the match!\n");
		else
			bprint (PRINT_HIGH, "The match is a draw\n");
	}
	else
	{
		best = world;
		p = find (world, classname, "player");
		while (p)
		{
			if (p.qt_connected)
			if (!best || p.frags > best.frags)
				best = p;
			p = find (p, classname, "player");
		}
		if (best)
		{
			if (Match_IsTie ())
				bprint (PRINT_HIGH, "The match is a draw\n");
			else
			{
				bprint (PRINT_HIGH, best.netname);
				bprint (PRINT_HIGH, " wins the match!\n");
			}
		}
	}

	p = find (world, classname, "player");
	while (p)
	{
		if (p.qt_connected)
			Match_PrintPlayer (p);
		p = find (p, classname, "player");
	}
};

void() Match_End =
{
	if (match_phase == PHASE_INTERMISSION)
		return;
	match_phase = PHASE_INTERMISSION;
	match_endtime = 0;
	match_countdownend = 0;
	Match_PrintResults ();
	CTF_ResetFlags ();
	execute_changelevel ();         // intermission spot, intermission_exittime
	match_countdownend = intermission_exittime;
	state_dirty = TRUE;
};

void() Match_CheckRules =
{
	local entity p;

	if (qt_mode == MODE_CA)
	{
		CA_Frame ();
		return;
	}

	// a match needs its players (duel: both, teams: one each)
	if (qt_readyup && !Match_CanStart ())
	{
		bprint (PRINT_HIGH, "Not enough players left\n");
		Match_End ();
		return;
	}

	if (fraglimit)
	{
		if (qt_mode == MODE_2ON2 || qt_mode == MODE_4ON4)
		{
			if (team1score >= fraglimit || team2score >= fraglimit)
			{
				Match_End ();
				return;
			}
		}
		else if (qt_mode != MODE_CTF)
		{
			p = find (world, classname, "player");
			while (p)
			{
				if (p.qt_connected && p.frags >= fraglimit)
				{
					Match_End ();
					return;
				}
				p = find (p, classname, "player");
			}
		}
	}

	if (qt_mode == MODE_CTF && capturelimit)
	if (team1caps >= capturelimit || team2caps >= capturelimit)
	{
		Match_End ();
		return;
	}

	if (match_phase == PHASE_OVERTIME && overtime_sd)
	{
		if (!Match_IsTie ())
			Match_End ();
		return;
	}

	if (match_endtime && time >= match_endtime)
	{
		// up to 3 overtimes, then a draw
		if (qt_mode != MODE_FFA && (overtime_sd || overtime_len > 0) && Match_IsTie () &&
			overtime_count < 3)
		{
			overtime_count = overtime_count + 1;
			match_phase = PHASE_OVERTIME;
			if (overtime_sd)
			{
				match_endtime = 0;
				bprint (PRINT_HIGH, "Tie: sudden death overtime!\n");
				CenterAll ("SUDDEN DEATH");
			}
			else
			{
				match_endtime = time + overtime_len;
				bprint (PRINT_HIGH, "Tie: ");
				bprint (PRINT_HIGH, ftos (overtime_len / 60));
				bprint (PRINT_HIGH, " minutes overtime!\n");
				CenterAll ("OVERTIME");
			}
			state_dirty = TRUE;
			return;
		}
		Match_End ();
	}
};

void() Match_WarmupFrame =
{
	local entity p;
	local float canstart;

	canstart = Match_CanStart ();
	if (canstart && Match_AllReady ())
	{
		Match_StartCountdown ();
		return;
	}

	if (time < warmup_hint_time)
		return;
	warmup_hint_time = time + 10;
	p = find (world, classname, "player");
	while (p)
	{
		if (p.qt_connected && !qt_isbot (p))
		{
			if (!canstart)
			{
				if (qt_mode == MODE_DUEL)
					centerprint (p, "WARMUP\n\nwaiting for an opponent");
				else
					centerprint (p, "WARMUP\n\nwaiting for players on both teams");
			}
			else if (!p.qt_ready)
				centerprint (p, "WARMUP\n\ntype  ready  when you are");
		}
		p = find (p, classname, "player");
	}
};

void() Match_CountdownFrame =
{
	local float n;
	local entity p;

	if (!Match_CanStart () || !Match_AllReady ())
	{
		Match_AbortCountdown ();
		return;
	}
	n = ceil (match_countdownend - time);
	if (n <= 0)
	{
		Match_Start ();
		return;
	}
	if (n != countdown_last)
	{
		countdown_last = n;
		CenterAll (strcat (strcat (mode_name, "\n\nmatch starts in\n\n"), ftos (n)));
		p = find (world, classname, "player");
		while (p && !p.qt_connected)
			p = find (p, classname, "player");
		if (p)
			sound (p, CHAN_AUTO, "buttons/switch04.wav", 1, ATTN_NONE);
	}
};

/*
============
Match_Frame

StartFrame, once per tick.
============
*/
void() CTF_AutoFlags;
void() SelfTest_Frame;

void() Match_Frame =
{
	if (framecount == 1)
		CTF_AutoFlags ();

	if (match_phase == PHASE_INTERMISSION)
	{
		if (time >= intermission_exittime)
			Match_GotoNextMap ();
	}
	else if (match_phase == PHASE_WARMUP)
		Match_WarmupFrame ();
	else if (match_phase == PHASE_COUNTDOWN)
		Match_CountdownFrame ();
	else if (match_phase == PHASE_ROUNDBREAK)
		CA_RoundBreakFrame ();
	else
		Match_CheckRules ();

	SelfTest_Frame ();
	if (state_dirty)
		QT_SendState ();
};

/*
============
Match_GotoNextMap

The map after the current one in serverinfo "rotation" (space separated,
wraps around; the first one when the current map is not in the list).
============
*/
void() Match_GotoNextMap =
{
	local float n, i, found;

	if (changelevel_sent)
		return;
	changelevel_sent = TRUE;

	n = tokenize (infokey (world, "rotation"));
	if (n < 1)
	{
		changelevel (mapname);
		return;
	}
	found = -1;
	i = 0;
	while (i < n && found < 0)
	{
		if (argv (i) == mapname)
			found = i;
		i = i + 1;
	}
	i = found + 1;
	if (i >= n)
		i = 0;
	next_map_z = strzone (argv (i));
	bprint (PRINT_HIGH, "Next map: ");
	bprint (PRINT_HIGH, next_map_z);
	bprint (PRINT_HIGH, "\n");
	changelevel (next_map_z);
};

/*
============
Match_PlayerConnected

ClientConnect (self): a human or a bot takes a slot.
============
*/
void() Match_PlayerConnected =
{
	self.qt_connected = TRUE;
	self.qt_ready = qt_isbot (self);
	self.qt_break = FALSE;
	self.ca_out = FALSE;
	self.carriedflag = world;
	self.ctf_teamspawn = TRUE;
	self.ctf_lastreturn = self.ctf_lastcarrierfrag = -100;
	self.frags = 0;
	Stat_ResetPlayer (self);
	Team_AutoAssign (self);

	if (!qt_isbot (self))
	{
		sprint (self, PRINT_HIGH, "Mode: ");
		sprint (self, PRINT_HIGH, mode_name);
		sprint (self, PRINT_HIGH, "\n");
		if (qt_readyup && match_phase == PHASE_WARMUP)
			sprint (self, PRINT_HIGH, "Warmup: type  ready  to start the match,  break  to take it back\n");
		else if (match_phase == PHASE_PLAYING || match_phase == PHASE_OVERTIME)
		if (qt_readyup)
			sprint (self, PRINT_HIGH, "The match is on: you are in\n");
		warmup_hint_time = 0;
	}
	state_dirty = TRUE;
};

/*
============
Match_PlayerDisconnected

ClientDisconnect (self).
============
*/
void() Match_PlayerDisconnected =
{
	CTF_DropFlag (self);
	self.qt_connected = FALSE;
	self.qt_ready = FALSE;
	self.qteam = TEAM_NONE;
	self.ca_out = FALSE;
	self.classname = "disconnected";
	self.takedamage = DAMAGE_NO;
	self.solid = SOLID_NOT;
	self.modelindex = 0;
	self.weaponmodel = "";
	self.effects = 0;
	setorigin (self, self.origin);
	state_dirty = TRUE;
};

/*
============
Match_IntermissionJoin

PutClientInServer during the intermission (self).
============
*/
void() Match_IntermissionJoin =
{
	local entity pos;

	pos = FindIntermission ();
	self.takedamage = DAMAGE_NO;
	self.solid = SOLID_NOT;
	self.movetype = MOVETYPE_NONE;
	self.modelindex = 0;
	self.weaponmodel = "";
	self.view_ofs = '0 0 0';
	self.velocity = '0 0 0';
	setorigin (self, pos.origin);
	self.angles = self.v_angle = pos.mangle;
	self.fixangle = TRUE;

	msg_entity = self;
	WriteByte (MSG_ONE, SVC_INTERMISSION);
	WriteCoord (MSG_ONE, pos.origin_x);
	WriteCoord (MSG_ONE, pos.origin_y);
	WriteCoord (MSG_ONE, pos.origin_z);
	WriteAngle (MSG_ONE, pos.mangle_x);
	WriteAngle (MSG_ONE, pos.mangle_y);
	WriteAngle (MSG_ONE, pos.mangle_z);
};
