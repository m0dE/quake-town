/*
	qtdefs.qc

	qtdm globals, fields and prototypes (modes, match, teams, stats, CTF, CA).

	Copyright (C) 2026 Quake Town contributors

	This program is free software; you can redistribute it and/or
	modify it under the terms of the GNU General Public License
	as published by the Free Software Foundation; either version 2
	of the License, or (at your option) any later version.

	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
*/

float MODE_FFA  = 0;
float MODE_DUEL = 1;
float MODE_2ON2 = 2;
float MODE_4ON4 = 3;
float MODE_CTF  = 4;
float MODE_CA   = 5;

float TEAM_NONE = 0;
float TEAM_RED  = 1;
float TEAM_BLUE = 2;

// mode / rules (set once in worldspawn by QT_InitMode)
float   qt_mode;
float   qt_teammode;            // auto-team red/blue
float   qt_readyup;             // warmup + ready-up + countdown
float   qt_noitems;             // Clan Arena: no item spawns
float   overtime_len;           // seconds, 0 = none
float   overtime_sd;            // sudden death overtime
float   capturelimit;
float   ca_roundlimit;
float   ca_roundtime;           // seconds per round, 0 = none
string  mode_name;

// match state
float   match_phase;
float   match_endtime;          // sim seconds, 0 = none
float   match_countdownend;     // countdown / round break end
float   match_starttime;
float   team1score, team2score;
float   ca_round;
float   state_dirty;            // send qt_matchstate at the end of StartFrame
float   countdown_last;         // last announced countdown second
float   no_telefrag;            // PutClientInServer without spawn_tdeath
float   changelevel_sent;
string  next_map_z;             // zoned name of the next map
float   warmup_hint_time;
float   selftest_step;
float   overtime_count;

// player fields
.float  qt_connected;
.float  qt_ready;
.float  qt_break;
.float  qteam;
.float  ca_out;                 // Clan Arena: out of this round
.entity carriedflag;            // CTF: the flag this player carries
.float  ctf_lastreturn;         // CTF: time this player returned his flag
.float  ctf_lastcarrierfrag;    // CTF: time this player fragged an enemy carrier

// stats (ids in qtext.qc)
.float  st_kills, st_deaths, st_suicides, st_teamkills;
.float  st_dmg_given, st_dmg_taken;
.float  st_ra, st_ya, st_ga, st_mh, st_quad, st_pent, st_ring;
.float  st_rl_shots, st_rl_hits, st_lg_shots, st_lg_hits;
.float  st_sg_shots, st_sg_hits, st_ssg_shots, st_ssg_hits;
.float  st_gl_shots, st_gl_hits, st_eff;

// accuracy bookkeeping
float   bullet_hit_stat;        // ST_SG_HITS / ST_SSG_HITS while FireBullets runs
float   gl_hit;                 // a grenade explosion hurt an enemy
float   lg_hit;                 // a lightning shot hurt an enemy

// CTF flag fields
.float  flagteam;
.float  flagstate;
.entity flagcarrier;
.vector flaghome;
.float  flag_returntime;
float   FLAG_AT_BASE = 0;
float   FLAG_CARRIED = 1;
float   FLAG_DROPPED = 2;
entity  flag_red, flag_blue;
float   team1caps, team2caps;

// prototypes
void(entity p, float id, float n) Stat_Add;
void(entity p) Stat_ResetPlayer;
void(entity p, float n) AddFrags;
float(entity a, entity b) SameTeam;
void(entity p) Team_AutoAssign;
void(entity p, float t) Team_Set;
string(float t) TeamName;
void() QT_InitMode;
void() QT_SendState;
void() Match_Frame;
float() Match_CanFire;
float() Match_DamageAllowed;
void() Match_PlayerConnected;
void() Match_PlayerDisconnected;
void() Match_GotoNextMap;
void(entity targ, entity attacker) QT_Obituary;
void(entity p) CA_GiveKit;
float() CA_InRound;
void() CA_PlayerDied;
void(entity p) CTF_DropFlag;
void() CTF_ResetFlags;
void(entity targ, entity attacker) CTF_FragBonuses;
void() CTF_CarrierThink;
void(entity p) CTF_PlayerGone;
entity(string cls) SelectSpawnClass;
void() Match_IntermissionJoin;
void() GotoNextMap;
