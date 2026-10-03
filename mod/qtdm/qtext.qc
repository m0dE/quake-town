/*
	qtext.qc

	Quake Town QuakeC extensions and the FTE/DP string builtins qtdm uses.
	Numbers are the contract in DESIGN.md ("Quake Town QuakeC extensions").

	Copyright (C) 2026 Quake Town contributors

	This program is free software; you can redistribute it and/or
	modify it under the terms of the GNU General Public License
	as published by the Free Software Foundation; either version 2
	of the License, or (at your option) any later version.

	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
*/

// --- Quake Town extensions (#9000+) ---------------------------------------

// Event 11. killer: world = environment, == victim = suicide.
// flags: QT_OBF_TEAMKILL 1, QT_OBF_TELEFRAG 2.
void(entity victim, entity killer, float deathtype, float flags) qt_obituary = #9000;
// ClientRow word 8 + stat.
void(entity player, float stat, float value) qt_setstat = #9001;
// Event 12.
void(float phase, float endtime, float countdownend, float score1, float score2, float round) qt_matchstate = #9002;
// Writes the player's userinfo key (team, topcolor, bottomcolor, ...).
void(entity player, string key, string value) qt_setinfo = #9003;
float(entity player) qt_isbot = #9004;
// Event 14. item: stat ids 6..12, weapons 20 + weapon impulse (3 SSG .. 8 LG).
void(entity player, float item) qt_pickup = #9005;

// --- FTE / DP string extensions ------------------------------------------

float(string s) strlen = #114;
string(string s1, string s2) strcat = #115;
string(string s, float start, float length) substring = #116;
vector(string s) stov = #117;
string(string s) strzone = #118;
void(string s) strunzone = #119;
float(string s) tokenize = #441;
string(float n) argv = #442;
string(string name) cvar_string = #448;

// deathtype ids (DESIGN.md)
float DT_WORLD          = 0;
float DT_AXE            = 1;
float DT_SHOTGUN        = 2;
float DT_SSHOTGUN       = 3;
float DT_NAILGUN        = 4;
float DT_SNAILGUN       = 5;
float DT_GRENADE        = 6;
float DT_ROCKET         = 7;
float DT_LIGHTNING      = 8;
float DT_DISCHARGE      = 9;
float DT_TELEFRAG       = 10;
float DT_SQUISH         = 11;
float DT_LAVA           = 12;
float DT_SLIME          = 13;
float DT_WATER          = 14;
float DT_FALL           = 15;
float DT_SUICIDE        = 16;
float DT_TEAMKILL_OTHER = 17;

float QT_OBF_TEAMKILL   = 1;
float QT_OBF_TELEFRAG   = 2;

// qt stat ids (ClientRow words 8..31)
float ST_KILLS          = 0;
float ST_DEATHS         = 1;
float ST_SUICIDES       = 2;
float ST_TEAMKILLS      = 3;
float ST_DMG_GIVEN      = 4;
float ST_DMG_TAKEN      = 5;
float ST_RA             = 6;
float ST_YA             = 7;
float ST_GA             = 8;
float ST_MH             = 9;
float ST_QUAD           = 10;
float ST_PENT           = 11;
float ST_RING           = 12;
float ST_RL_SHOTS       = 13;
float ST_RL_HITS        = 14;
float ST_LG_SHOTS       = 15;
float ST_LG_HITS        = 16;
float ST_SG_SHOTS       = 17;
float ST_SG_HITS        = 18;
float ST_SSG_SHOTS      = 19;
float ST_SSG_HITS       = 20;
float ST_GL_SHOTS       = 21;
float ST_GL_HITS        = 22;
float ST_EFFICIENCY     = 23;
float ST_COUNT          = 24;

// match phases
float PHASE_WARMUP       = 0;
float PHASE_COUNTDOWN    = 1;
float PHASE_PLAYING      = 2;
float PHASE_OVERTIME     = 3;
float PHASE_INTERMISSION = 4;
float PHASE_ROUNDBREAK   = 5;
