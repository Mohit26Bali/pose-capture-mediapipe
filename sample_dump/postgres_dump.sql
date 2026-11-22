--
-- PostgreSQL database dump
--

-- Dumped from database version 17.4
-- Dumped by pg_dump version 17.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.set_updated_at() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: pose_records; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.pose_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mongo_image_id character(24) NOT NULL,
    mongo_db text NOT NULL,
    mongo_collection text NOT NULL,
    original_filename text,
    content_type text NOT NULL,
    file_size_bytes integer,
    pose_detected boolean DEFAULT false NOT NULL,
    landmark_count integer DEFAULT 0 NOT NULL,
    keypoints jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.pose_records OWNER TO postgres;

--
-- Data for Name: pose_records; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.pose_records (id, mongo_image_id, mongo_db, mongo_collection, original_filename, content_type, file_size_bytes, pose_detected, landmark_count, keypoints, created_at, updated_at) FROM stdin;
ca0658d8-48a0-4af1-8ba9-98ce8e67ce06	6a78241ce0813dc08bf27b7d	pose_capture	images	sample_pose.jpg	image/jpeg	10762	t	33	[{"x": 0.464189, "y": 0.277454, "z": -1.228351, "name": "NOSE", "index": 0, "visibility": 0.999914}, {"x": 0.486365, "y": 0.243485, "z": -1.21374, "name": "LEFT_EYE_INNER", "index": 1, "visibility": 0.99985}, {"x": 0.503323, "y": 0.239588, "z": -1.213708, "name": "LEFT_EYE", "index": 2, "visibility": 0.999793}, {"x": 0.518874, "y": 0.235719, "z": -1.214214, "name": "LEFT_EYE_OUTER", "index": 3, "visibility": 0.999758}, {"x": 0.433228, "y": 0.247959, "z": -1.199738, "name": "RIGHT_EYE_INNER", "index": 4, "visibility": 0.999902}, {"x": 0.415708, "y": 0.247042, "z": -1.199818, "name": "RIGHT_EYE", "index": 5, "visibility": 0.999882}, {"x": 0.399071, "y": 0.245973, "z": -1.200137, "name": "RIGHT_EYE_OUTER", "index": 6, "visibility": 0.9999}, {"x": 0.543833, "y": 0.227437, "z": -0.841999, "name": "LEFT_EAR", "index": 7, "visibility": 0.999874}, {"x": 0.375077, "y": 0.244148, "z": -0.776029, "name": "RIGHT_EAR", "index": 8, "visibility": 0.999975}, {"x": 0.500439, "y": 0.296927, "z": -1.058502, "name": "MOUTH_LEFT", "index": 9, "visibility": 0.999981}, {"x": 0.441094, "y": 0.302303, "z": -1.039734, "name": "MOUTH_RIGHT", "index": 10, "visibility": 0.999987}, {"x": 0.724324, "y": 0.320891, "z": -0.493026, "name": "LEFT_SHOULDER", "index": 11, "visibility": 0.999969}, {"x": 0.258418, "y": 0.367815, "z": -0.382662, "name": "RIGHT_SHOULDER", "index": 12, "visibility": 0.999959}, {"x": 0.918213, "y": 0.528718, "z": -0.483752, "name": "LEFT_ELBOW", "index": 13, "visibility": 0.997979}, {"x": 0.134938, "y": 0.583894, "z": -0.46836, "name": "RIGHT_ELBOW", "index": 14, "visibility": 0.994099}, {"x": 0.668853, "y": 0.59188, "z": -0.950821, "name": "LEFT_WRIST", "index": 15, "visibility": 0.991888}, {"x": 0.353917, "y": 0.619435, "z": -1.016762, "name": "RIGHT_WRIST", "index": 16, "visibility": 0.97987}, {"x": 0.595679, "y": 0.638208, "z": -1.063877, "name": "LEFT_PINKY", "index": 17, "visibility": 0.974288}, {"x": 0.418835, "y": 0.658134, "z": -1.133225, "name": "RIGHT_PINKY", "index": 18, "visibility": 0.952295}, {"x": 0.557065, "y": 0.607926, "z": -1.051735, "name": "LEFT_INDEX", "index": 19, "visibility": 0.972607}, {"x": 0.452761, "y": 0.620668, "z": -1.112435, "name": "RIGHT_INDEX", "index": 20, "visibility": 0.94648}, {"x": 0.567642, "y": 0.594254, "z": -0.938609, "name": "LEFT_THUMB", "index": 21, "visibility": 0.96288}, {"x": 0.440335, "y": 0.607045, "z": -1.007064, "name": "RIGHT_THUMB", "index": 22, "visibility": 0.932189}, {"x": 0.714331, "y": 0.720352, "z": -0.049925, "name": "LEFT_HIP", "index": 23, "visibility": 0.990182}, {"x": 0.438712, "y": 0.726442, "z": 0.050686, "name": "RIGHT_HIP", "index": 24, "visibility": 0.992627}, {"x": 0.860477, "y": 1.045833, "z": -0.621436, "name": "LEFT_KNEE", "index": 25, "visibility": 0.856039}, {"x": 0.196601, "y": 0.918544, "z": -0.666619, "name": "RIGHT_KNEE", "index": 26, "visibility": 0.899218}, {"x": 0.77521, "y": 1.209156, "z": 0.386043, "name": "LEFT_ANKLE", "index": 27, "visibility": 0.239533}, {"x": 0.414837, "y": 1.092717, "z": 0.248645, "name": "RIGHT_ANKLE", "index": 28, "visibility": 0.340802}, {"x": 0.742807, "y": 1.223137, "z": 0.480694, "name": "LEFT_HEEL", "index": 29, "visibility": 0.297429}, {"x": 0.482775, "y": 1.10184, "z": 0.338585, "name": "RIGHT_HEEL", "index": 30, "visibility": 0.406746}, {"x": 0.8241, "y": 1.313499, "z": 0.230628, "name": "LEFT_FOOT_INDEX", "index": 31, "visibility": 0.120183}, {"x": 0.398295, "y": 1.222202, "z": 0.108657, "name": "RIGHT_FOOT_INDEX", "index": 32, "visibility": 0.147625}]	2026-08-09 12:24:25.247534+05:30	2026-08-09 12:24:25.247534+05:30
c0cfb6da-b010-4da1-ae25-8cb61306b3ea	6a782479e0813dc08bf27b7e	pose_capture	images	renamed.jpg	image/jpeg	10762	t	33	[{"x": 0.464189, "y": 0.277454, "z": -1.228351, "name": "NOSE", "index": 0, "visibility": 0.999914}, {"x": 0.486365, "y": 0.243485, "z": -1.21374, "name": "LEFT_EYE_INNER", "index": 1, "visibility": 0.99985}, {"x": 0.503323, "y": 0.239588, "z": -1.213708, "name": "LEFT_EYE", "index": 2, "visibility": 0.999793}, {"x": 0.518874, "y": 0.235719, "z": -1.214214, "name": "LEFT_EYE_OUTER", "index": 3, "visibility": 0.999758}, {"x": 0.433228, "y": 0.247959, "z": -1.199738, "name": "RIGHT_EYE_INNER", "index": 4, "visibility": 0.999902}, {"x": 0.415708, "y": 0.247042, "z": -1.199818, "name": "RIGHT_EYE", "index": 5, "visibility": 0.999882}, {"x": 0.399071, "y": 0.245973, "z": -1.200137, "name": "RIGHT_EYE_OUTER", "index": 6, "visibility": 0.9999}, {"x": 0.543833, "y": 0.227437, "z": -0.841999, "name": "LEFT_EAR", "index": 7, "visibility": 0.999874}, {"x": 0.375077, "y": 0.244148, "z": -0.776029, "name": "RIGHT_EAR", "index": 8, "visibility": 0.999975}, {"x": 0.500439, "y": 0.296927, "z": -1.058502, "name": "MOUTH_LEFT", "index": 9, "visibility": 0.999981}, {"x": 0.441094, "y": 0.302303, "z": -1.039734, "name": "MOUTH_RIGHT", "index": 10, "visibility": 0.999987}, {"x": 0.724324, "y": 0.320891, "z": -0.493026, "name": "LEFT_SHOULDER", "index": 11, "visibility": 0.999969}, {"x": 0.258418, "y": 0.367815, "z": -0.382662, "name": "RIGHT_SHOULDER", "index": 12, "visibility": 0.999959}, {"x": 0.918213, "y": 0.528718, "z": -0.483752, "name": "LEFT_ELBOW", "index": 13, "visibility": 0.997979}, {"x": 0.134938, "y": 0.583894, "z": -0.46836, "name": "RIGHT_ELBOW", "index": 14, "visibility": 0.994099}, {"x": 0.668853, "y": 0.59188, "z": -0.950821, "name": "LEFT_WRIST", "index": 15, "visibility": 0.991888}, {"x": 0.353917, "y": 0.619435, "z": -1.016762, "name": "RIGHT_WRIST", "index": 16, "visibility": 0.97987}, {"x": 0.595679, "y": 0.638208, "z": -1.063877, "name": "LEFT_PINKY", "index": 17, "visibility": 0.974288}, {"x": 0.418835, "y": 0.658134, "z": -1.133225, "name": "RIGHT_PINKY", "index": 18, "visibility": 0.952295}, {"x": 0.557065, "y": 0.607926, "z": -1.051735, "name": "LEFT_INDEX", "index": 19, "visibility": 0.972607}, {"x": 0.452761, "y": 0.620668, "z": -1.112435, "name": "RIGHT_INDEX", "index": 20, "visibility": 0.94648}, {"x": 0.567642, "y": 0.594254, "z": -0.938609, "name": "LEFT_THUMB", "index": 21, "visibility": 0.96288}, {"x": 0.440335, "y": 0.607045, "z": -1.007064, "name": "RIGHT_THUMB", "index": 22, "visibility": 0.932189}, {"x": 0.714331, "y": 0.720352, "z": -0.049925, "name": "LEFT_HIP", "index": 23, "visibility": 0.990182}, {"x": 0.438712, "y": 0.726442, "z": 0.050686, "name": "RIGHT_HIP", "index": 24, "visibility": 0.992627}, {"x": 0.860477, "y": 1.045833, "z": -0.621436, "name": "LEFT_KNEE", "index": 25, "visibility": 0.856039}, {"x": 0.196601, "y": 0.918544, "z": -0.666619, "name": "RIGHT_KNEE", "index": 26, "visibility": 0.899218}, {"x": 0.77521, "y": 1.209156, "z": 0.386043, "name": "LEFT_ANKLE", "index": 27, "visibility": 0.239533}, {"x": 0.414837, "y": 1.092717, "z": 0.248645, "name": "RIGHT_ANKLE", "index": 28, "visibility": 0.340802}, {"x": 0.742807, "y": 1.223137, "z": 0.480694, "name": "LEFT_HEEL", "index": 29, "visibility": 0.297429}, {"x": 0.482775, "y": 1.10184, "z": 0.338585, "name": "RIGHT_HEEL", "index": 30, "visibility": 0.406746}, {"x": 0.8241, "y": 1.313499, "z": 0.230628, "name": "LEFT_FOOT_INDEX", "index": 31, "visibility": 0.120183}, {"x": 0.398295, "y": 1.222202, "z": 0.108657, "name": "RIGHT_FOOT_INDEX", "index": 32, "visibility": 0.147625}]	2026-08-09 12:25:58.367673+05:30	2026-08-09 12:26:47.252748+05:30
\.


--
-- Name: pose_records pose_records_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pose_records
    ADD CONSTRAINT pose_records_pkey PRIMARY KEY (id);


--
-- Name: idx_pose_records_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_pose_records_created_at ON public.pose_records USING btree (created_at DESC);


--
-- Name: idx_pose_records_mongo_image_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_pose_records_mongo_image_id ON public.pose_records USING btree (mongo_image_id);


--
-- Name: pose_records trg_pose_records_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_pose_records_updated_at BEFORE UPDATE ON public.pose_records FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- PostgreSQL database dump complete
--

